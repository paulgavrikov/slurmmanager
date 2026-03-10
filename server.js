const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Store active SSH sessions per WebSocket client
const sessions = new Map();
let wsCounter = 0;

// ===== Logging =====
function log(tag, msg, ...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${tag}] ${msg}`, ...args);
}

function parseSinfo(raw) {
  const lines = raw.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0];
  const cols = header.split(/\s{2,}/).map(c => c.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = line.split(/\s{2,}/).map(v => v.trim());
    const obj = {};
    cols.forEach((c, i) => { obj[c] = vals[i] || ''; });
    return obj;
  });
}

function parseSqueue(raw) {
  const lines = raw.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0];
  const cols = header.split(/\s{2,}/).map(c => c.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = line.split(/\s{2,}/).map(v => v.trim());
    const obj = {};
    cols.forEach((c, i) => { obj[c] = vals[i] || ''; });
    return obj;
  });
}

function parseSacct(raw) {
  const lines = raw.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0];
  const cols = header.split('|').map(c => c.trim().toLowerCase());
  return lines.slice(1).filter(l => !l.startsWith('--')).map(line => {
    const vals = line.split('|').map(v => v.trim());
    const obj = {};
    cols.forEach((c, i) => { obj[c] = vals[i] || ''; });
    return obj;
  });
}

function parseScontrolJob(raw) {
  const result = {};
  const pairs = raw.replace(/\n\s+/g, ' ').split(/\s+/);
  pairs.forEach(p => {
    const eq = p.indexOf('=');
    if (eq > 0) {
      result[p.substring(0, eq)] = p.substring(eq + 1);
    }
  });
  return result;
}

function parseScontrolNode(raw) {
  const nodes = [];
  const blocks = raw.split(/\n(?=NodeName=)/);
  blocks.forEach(block => {
    if (!block.trim()) return;
    const result = {};
    const pairs = block.replace(/\n\s+/g, ' ').split(/\s+/);
    pairs.forEach(p => {
      const eq = p.indexOf('=');
      if (eq > 0) {
        result[p.substring(0, eq)] = p.substring(eq + 1);
      }
    });
    if (Object.keys(result).length > 0) nodes.push(result);
  });
  return nodes;
}

function parsePipe(raw) {
  const lines = raw.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const cols = lines[0].split('|').map(c => c.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = line.split('|').map(v => v.trim());
    const obj = {};
    cols.forEach((c, i) => { obj[c] = vals[i] || ''; });
    return obj;
  });
}

function parseScontrolPartition(raw) {
  const partitions = [];
  const blocks = raw.split(/\n(?=PartitionName=)/);
  blocks.forEach(block => {
    if (!block.trim()) return;
    const result = {};
    const pairs = block.replace(/\n\s+/g, ' ').split(/\s+/);
    pairs.forEach(p => {
      const eq = p.indexOf('=');
      if (eq > 0) {
        result[p.substring(0, eq)] = p.substring(eq + 1);
      }
    });
    if (Object.keys(result).length > 0) partitions.push(result);
  });
  return partitions;
}

function execSSHCommand(sshClient, command, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    log('SSH', `exec: ${command.slice(0, 80)}${command.length > 80 ? '…' : ''}`);
    const timer = setTimeout(() => {
      log('SSH', `TIMEOUT after ${timeout}ms: ${command.slice(0, 60)}`);
      reject(new Error('Command timed out'));
    }, timeout);
    sshClient.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); log('SSH', `exec error: ${err.message}`); return reject(err); }
      let stdout = '';
      let stderr = '';
      stream.on('data', (data) => { stdout += data.toString(); });
      stream.stderr.on('data', (data) => { stderr += data.toString(); });
      stream.on('close', () => {
        clearTimeout(timer);
        const elapsed = Date.now() - start;
        log('SSH', `done (${elapsed}ms): ${command.slice(0, 60)} → stdout=${stdout.length}B stderr=${stderr.length}B`);
        resolve({ stdout, stderr });
      });
    });
  });
}

wss.on('connection', (ws) => {
  const clientId = ++wsCounter;
  let sshClient = null;
  let pollInterval = null;
  let username = '';
  log('WS', `client #${clientId} connected`);

  function send(type, data) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, data }));
    }
  }

  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    log('POLL', `client #${clientId}: starting 10s auto-refresh`);
    pollInterval = setInterval(async () => {
      if (!sshClient) return;
      try {
        log('POLL', `client #${clientId}: refreshing data`);
        await refreshAll();
      } catch (e) {
        log('POLL', `client #${clientId}: error – ${e.message}`);
        handleDisconnect('Polling error: ' + e.message);
      }
    }, 10000);
  }

  async function refreshAll() {
    try {
      const [sinfoRes, sinfoNodesRes, squeueMeRes, squeueAllRes] = await Promise.all([
        execSSHCommand(sshClient, 'sinfo -o "%20P  %10a  %6D  %10T  %8c  %12m  %80N  %12G  %10e  %10O"'),
        execSSHCommand(sshClient, 'sinfo -N -o "%N|%P|%T|%c|%m|%G|%e|%O"'),
        execSSHCommand(sshClient, `squeue -u ${username} -o "%18i  %12j  %12u  %10P  %8T  %12M  %12l  %8D  %6C  %12R  %20V"`),
        execSSHCommand(sshClient, 'squeue -o "%18i  %12j  %12u  %10P  %8T  %12M  %12l  %8D  %6C  %12R  %20V"'),
      ]);
      send('sinfo', parseSinfo(sinfoRes.stdout));
      send('sinfo_nodes', parsePipe(sinfoNodesRes.stdout));
      send('squeue_me', parseSqueue(squeueMeRes.stdout));
      send('squeue_all', parseSqueue(squeueAllRes.stdout));
    } catch (e) {
      throw e;
    }
  }

  function handleDisconnect(reason) {
    log('SSH', `client #${clientId} disconnected: ${reason}`);
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    if (sshClient) {
      try { sshClient.end(); } catch (_) {}
      sshClient = null;
    }
    send('disconnected', { reason });
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    log('WS', `client #${clientId} → ${msg.type}${msg.data?.jobId ? ' job=' + msg.data.jobId : ''}${msg.data?.host ? ' host=' + msg.data.host : ''}`);

    switch (msg.type) {
      case 'connect': {
        const { host, port, user, password, privateKey } = msg.data;
        username = user;
        sshClient = new Client();

        sshClient.on('ready', async () => {
          log('SSH', `client #${clientId}: connected to ${host} as ${user}`);
          send('connected', { host, user });
          try {
            await refreshAll();
            startPolling();
          } catch (e) {
            log('SSH', `client #${clientId}: initial fetch failed – ${e.message}`);
            send('error', { message: 'Initial data fetch failed: ' + e.message });
          }
        });

        sshClient.on('error', (err) => {
          log('SSH', `client #${clientId}: SSH error – ${err.message}`);
          handleDisconnect('SSH error: ' + err.message);
        });

        sshClient.on('end', () => {
          handleDisconnect('SSH connection ended');
        });

        sshClient.on('close', () => {
          handleDisconnect('SSH connection closed');
        });

        const connectConfig = {
          host,
          port: parseInt(port) || 22,
          username: user,
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
          readyTimeout: 20000,
        };

        if (privateKey) {
          connectConfig.privateKey = privateKey;
          if (password) connectConfig.passphrase = password;
        } else if (password) {
          connectConfig.password = password;
        } else {
          // No password or key provided — try default SSH keys from ~/.ssh/
          const sshDir = path.join(os.homedir(), '.ssh');
          const keyNames = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa'];
          let foundKey = false;
          for (const name of keyNames) {
            const keyPath = path.join(sshDir, name);
            try {
              if (fs.existsSync(keyPath)) {
                connectConfig.privateKey = fs.readFileSync(keyPath);
                log('SSH', `client #${clientId}: using key from ${keyPath}`);
                foundKey = true;
                break;
              }
            } catch (_) {}
          }
          if (!foundKey && process.env.SSH_AUTH_SOCK) {
            connectConfig.agent = process.env.SSH_AUTH_SOCK;
            log('SSH', `client #${clientId}: no key files found, falling back to SSH agent`);
          } else if (!foundKey) {
            log('SSH', `client #${clientId}: no keys or agent available — connection will likely fail`);
          }
        }

        try {
          log('SSH', `client #${clientId}: connecting to ${host}:${connectConfig.port}…`);
          sshClient.connect(connectConfig);
        } catch (e) {
          log('SSH', `client #${clientId}: connect exception – ${e.message}`);
          send('error', { message: 'Connection failed: ' + e.message });
        }
        break;
      }

      case 'disconnect': {
        handleDisconnect('User disconnected');
        break;
      }

      case 'refresh': {
        if (!sshClient) { send('error', { message: 'Not connected' }); break; }
        try {
          await refreshAll();
        } catch (e) {
          handleDisconnect('Refresh failed: ' + e.message);
        }
        break;
      }

      case 'cancel_job': {
        if (!sshClient) { send('error', { message: 'Not connected' }); break; }
        try {
          const res = await execSSHCommand(sshClient, `scancel ${msg.data.jobId}`);
          send('job_cancelled', { jobId: msg.data.jobId, stderr: res.stderr });
          // refresh after cancel
          setTimeout(() => refreshAll().catch(() => {}), 1000);
        } catch (e) {
          send('error', { message: 'Cancel failed: ' + e.message });
        }
        break;
      }

      case 'job_details': {
        if (!sshClient) { send('error', { message: 'Not connected' }); break; }
        try {
          const res = await execSSHCommand(sshClient, `scontrol show job ${msg.data.jobId}`);
          send('job_details', parseScontrolJob(res.stdout));
        } catch (e) {
          send('error', { message: 'Job detail fetch failed: ' + e.message });
        }
        break;
      }

      case 'node_details': {
        if (!sshClient) { send('error', { message: 'Not connected' }); break; }
        try {
          const res = await execSSHCommand(sshClient, `scontrol show node ${msg.data.nodeName}`);
          const nodes = parseScontrolNode(res.stdout);
          send('node_details', nodes[0] || {});
        } catch (e) {
          send('error', { message: 'Node detail fetch failed: ' + e.message });
        }
        break;
      }

      case 'job_history': {
        if (!sshClient) { send('error', { message: 'Not connected' }); break; }
        try {
          const startDate = msg.data?.startDate || '2020-01-01';
          const res = await execSSHCommand(sshClient,
            `sacct -u ${username} --starttime=${startDate} --format=JobID,JobName%30,Partition,Account,AllocCPUS,State,ExitCode,Elapsed,Start,End,NodeList,MaxRSS -p`
          );
          send('job_history', parseSacct(res.stdout));
        } catch (e) {
          send('error', { message: 'Job history fetch failed: ' + e.message });
        }
        break;
      }

      case 'partition_info': {
        if (!sshClient) { send('error', { message: 'Not connected' }); break; }
        try {
          const res = await execSSHCommand(sshClient, 'scontrol show partition');
          send('partition_info', parseScontrolPartition(res.stdout));
        } catch (e) {
          send('error', { message: 'Partition info fetch failed: ' + e.message });
        }
        break;
      }

      case 'submit_job': {
        if (!sshClient) { send('error', { message: 'Not connected' }); break; }
        try {
          const script = msg.data.script;
          // Write script to a temp file and submit
          const tmpFile = `/tmp/slurm_submit_${Date.now()}.sh`;
          await execSSHCommand(sshClient, `cat > ${tmpFile} << 'SLURMEOF'\n${script}\nSLURMEOF`);
          const res = await execSSHCommand(sshClient, `sbatch ${tmpFile}`);
          await execSSHCommand(sshClient, `rm -f ${tmpFile}`);
          send('job_submitted', { stdout: res.stdout, stderr: res.stderr });
          setTimeout(() => refreshAll().catch(() => {}), 1000);
        } catch (e) {
          send('error', { message: 'Submit failed: ' + e.message });
        }
        break;
      }

      case 'job_output': {
        if (!sshClient) { send('error', { message: 'Not connected' }); break; }
        try {
          const filePath = msg.data.filePath;
          const lines = msg.data.lines || 100;
          const res = await execSSHCommand(sshClient, `tail -n ${lines} ${filePath}`);
          send('job_output', { filePath, content: res.stdout, stderr: res.stderr });
        } catch (e) {
          send('error', { message: 'Output fetch failed: ' + e.message });
        }
        break;
      }

      case 'hold_job': {
        if (!sshClient) { send('error', { message: 'Not connected' }); break; }
        try {
          const res = await execSSHCommand(sshClient, `scontrol hold ${msg.data.jobId}`);
          send('job_held', { jobId: msg.data.jobId, stderr: res.stderr });
          setTimeout(() => refreshAll().catch(() => {}), 1000);
        } catch (e) {
          send('error', { message: 'Hold failed: ' + e.message });
        }
        break;
      }

      case 'release_job': {
        if (!sshClient) { send('error', { message: 'Not connected' }); break; }
        try {
          const res = await execSSHCommand(sshClient, `scontrol release ${msg.data.jobId}`);
          send('job_released', { jobId: msg.data.jobId, stderr: res.stderr });
          setTimeout(() => refreshAll().catch(() => {}), 1000);
        } catch (e) {
          send('error', { message: 'Release failed: ' + e.message });
        }
        break;
      }

      case 'cluster_usage': {
        if (!sshClient) { send('error', { message: 'Not connected' }); break; }
        try {
          const [sinfoLong, squeue] = await Promise.all([
            execSSHCommand(sshClient, 'sinfo -N -l'),
            execSSHCommand(sshClient, 'squeue -o "%T" --noheader'),
          ]);
          const jobStates = squeue.stdout.trim().split('\n').filter(l => l.trim());
          const stateCounts = {};
          jobStates.forEach(s => {
            const st = s.trim();
            stateCounts[st] = (stateCounts[st] || 0) + 1;
          });
          send('cluster_usage', {
            nodeInfo: sinfoLong.stdout,
            jobStateCounts: stateCounts,
            totalJobs: jobStates.length,
          });
        } catch (e) {
          send('error', { message: 'Cluster usage fetch failed: ' + e.message });
        }
        break;
      }

      default:
        send('error', { message: `Unknown command: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    log('WS', `client #${clientId} WebSocket closed`);
    handleDisconnect('WebSocket closed');
    sessions.delete(ws);
  });

  sessions.set(ws, { sshClient });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log('SERVER', `Slurm Manager running on http://localhost:${PORT}`);
});
