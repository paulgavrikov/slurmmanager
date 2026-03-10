/* ===== Slurm Manager Frontend ===== */
(function() {
  'use strict';

  // ===== State =====
  let ws = null;
  let connectionInfo = {};
  let sinfoData = [];
  let squeueMeData = [];
  let squeueAllData = [];
  let sinfoNodesData = [];
  let historyData = [];
  let sortState = {};

  // ===== Credential Storage =====
  const STORAGE_KEY = 'slurm_manager_creds';

  function saveCredentials(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  function loadCredentials() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function clearCredentials() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  // ===== DOM Refs =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const connectModal = $('#connect-modal');
  const reconnectModal = $('#reconnect-modal');
  const jobDetailModal = $('#job-detail-modal');
  const nodeDetailModal = $('#node-detail-modal');
  const outputModal = $('#output-modal');
  const connectForm = $('#connect-form');
  const connectBtn = $('#connect-btn');
  const connectError = $('#connect-error');
  const app = $('#app');
  const disconnectReason = $('#disconnect-reason');

  // ===== Toast System =====
  const toastContainer = document.createElement('div');
  toastContainer.className = 'toast-container';
  document.body.appendChild(toastContainer);

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  // ===== Confirm Dialog =====
  function showConfirm(title, message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML = `
        <div class="confirm-box">
          <h3>${title}</h3>
          <p>${message}</p>
          <div class="confirm-actions">
            <button class="btn" id="confirm-no">Cancel</button>
            <button class="btn btn-primary" id="confirm-yes">Confirm</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('#confirm-yes').onclick = () => { overlay.remove(); resolve(true); };
      overlay.querySelector('#confirm-no').onclick = () => { overlay.remove(); resolve(false); };
    });
  }

  // ===== WebSocket =====
  function initWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      console.log('WebSocket connected');
    };

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      handleMessage(msg);
    };

    ws.onclose = () => {
      console.log('WebSocket closed');
    };

    ws.onerror = (err) => {
      console.error('WebSocket error', err);
    };
  }

  function wsSend(type, data = {}) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type, data }));
    }
  }

  // ===== Message Handler =====
  function handleMessage(msg) {
    switch (msg.type) {
      case 'connected':
        onConnected(msg.data);
        break;
      case 'disconnected':
        onDisconnected(msg.data);
        break;
      case 'sinfo':
        sinfoData = msg.data;
        renderDashboard();
        break;
      case 'sinfo_nodes':
        sinfoNodesData = msg.data;
        renderNodes();
        break;
      case 'squeue_me':
        squeueMeData = msg.data;
        renderMyJobs();
        renderDashboard();
        break;
      case 'squeue_all':
        squeueAllData = msg.data;
        renderAllJobs();
        renderDashboard();
        break;
      case 'job_details':
        renderJobDetails(msg.data);
        break;
      case 'node_details':
        renderNodeDetails(msg.data);
        break;
      case 'job_cancelled':
        showToast(`Job ${msg.data.jobId} cancelled`, msg.data.stderr ? 'error' : 'success');
        break;
      case 'job_held':
        showToast(`Job ${msg.data.jobId} held`, 'success');
        break;
      case 'job_released':
        showToast(`Job ${msg.data.jobId} released`, 'success');
        break;
      case 'job_history':
        historyData = msg.data;
        renderHistory();
        break;
      case 'job_submitted':
        onJobSubmitted(msg.data);
        break;
      case 'job_output':
        renderJobOutput(msg.data);
        break;
      case 'partition_info':
        renderPartitions(msg.data);
        break;
      case 'cluster_usage':
        // Additional stat update
        break;
      case 'error':
        showToast(msg.data.message, 'error');
        // If connect failed
        if (connectModal.classList.contains('active')) {
          connectError.textContent = msg.data.message;
          connectError.classList.remove('hidden');
          setConnectLoading(false);
        }
        break;
    }
  }

  // ===== Connection =====
  function onConnected(data) {
    connectionInfo = data;
    connectModal.classList.remove('active');
    reconnectModal.classList.remove('active');
    connectError.classList.add('hidden');
    app.classList.remove('hidden');
    setConnectLoading(false);
    $('#topbar-title').textContent = `${data.user}@${data.host}`;
    $('#connection-status').className = 'conn-status connected';
    $('#conn-label').textContent = 'Connected';
    showToast(`Connected to ${data.host}`, 'success');

    // Save credentials if "Remember me" is checked
    if ($('#ssh-remember').checked) {
      saveCredentials({
        host: $('#ssh-host').value.trim(),
        port: $('#ssh-port').value,
        user: $('#ssh-user').value.trim(),
        password: $('#ssh-password').value,
        privateKey: $('#ssh-key').value.trim(),
      });
    } else {
      clearCredentials();
    }

    // Load partition info once
    wsSend('partition_info');
  }

  function onDisconnected(data) {
    app.classList.add('hidden');
    reconnectModal.classList.add('active');
    disconnectReason.textContent = data.reason || 'Connection lost';
    $('#connection-status').className = 'conn-status disconnected';
    $('#conn-label').textContent = 'Disconnected';
  }

  function setConnectLoading(loading) {
    const textEl = connectBtn.querySelector('.btn-text');
    const loadEl = connectBtn.querySelector('.btn-loader');
    if (loading) {
      textEl.classList.add('hidden');
      loadEl.classList.remove('hidden');
      connectBtn.disabled = true;
    } else {
      textEl.classList.remove('hidden');
      loadEl.classList.add('hidden');
      connectBtn.disabled = false;
    }
  }

  // ===== Tab Navigation =====
  function switchTab(tabName) {
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tabName}`));

    // Lazy load history
    if (tabName === 'history' && historyData.length === 0) {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      $('#history-start').value = d.toISOString().slice(0, 10);
      wsSend('job_history', { startDate: d.toISOString().slice(0, 10) });
    }
  }

  // ===== Table Rendering Helpers =====
  function createTable(data, columns, tableId, options = {}) {
    if (!data || data.length === 0) {
      return `<div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
        </svg>
        <p>No data available</p>
      </div>`;
    }

    const sort = sortState[tableId] || {};
    let sorted = [...data];
    if (sort.col !== undefined) {
      sorted.sort((a, b) => {
        const aVal = a[columns[sort.col].key] || '';
        const bVal = b[columns[sort.col].key] || '';
        const cmp = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' });
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }

    let html = '<table><thead><tr>';
    columns.forEach((col, i) => {
      let cls = '';
      if (sort.col === i) cls = sort.dir === 'asc' ? 'sorted sorted-asc' : 'sorted sorted-desc';
      html += `<th class="${cls}" data-table="${tableId}" data-col="${i}">${col.label}</th>`;
    });
    if (options.actions) html += '<th>Actions</th>';
    html += '</tr></thead><tbody>';

    sorted.forEach(row => {
      html += '<tr>';
      columns.forEach(col => {
        const val = row[col.key] || '';
        html += `<td>${col.render ? col.render(val, row) : escapeHtml(val)}</td>`;
      });
      if (options.actions) {
        html += `<td class="actions-cell">${options.actions(row)}</td>`;
      }
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function stateBadge(state) {
    if (!state) return '';
    const st = state.toLowerCase().replace(/[*~#!%$@+^]/g, '');
    const cleanState = state.replace(/[*~#!%$@+^]/g, '');
    return `<span class="badge badge-${st}">${escapeHtml(cleanState)}</span>`;
  }

  // Expand Slurm compressed hostlist notation, e.g.
  // "galvani-cn[053,054-058]" → ["galvani-cn053","galvani-cn054",..."galvani-cn058"]
  // "node[01-03],gpu[1,3]"   → ["node01","node02","node03","gpu1","gpu3"]
  function expandHostlist(hostlist) {
    if (!hostlist) return [];
    const nodes = [];
    // Split on commas that are outside brackets
    const segments = [];
    let depth = 0, current = '';
    for (const ch of hostlist) {
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        segments.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) segments.push(current.trim());

    for (const seg of segments) {
      const match = seg.match(/^(.+?)\[(.+)\]$/);
      if (match) {
        const prefix = match[1];
        const ranges = match[2].split(',');
        for (const r of ranges) {
          const dashMatch = r.trim().match(/^(\d+)-(\d+)$/);
          if (dashMatch) {
            const start = parseInt(dashMatch[1]);
            const end = parseInt(dashMatch[2]);
            const padLen = dashMatch[1].length;
            for (let i = start; i <= end; i++) {
              nodes.push(prefix + String(i).padStart(padLen, '0'));
            }
          } else {
            nodes.push(prefix + r.trim());
          }
        }
      } else {
        nodes.push(seg);
      }
    }
    return nodes;
  }

  function nodeLink(nodelist) {
    if (!nodelist) return '';
    // Don't linkify non-node values
    if (/^(none|None|N\/A|n\/a|\s)*assigned/i.test(nodelist) || nodelist.toLowerCase() === 'none') {
      return escapeHtml(nodelist);
    }
    const segments = [];
    let depth = 0, current = '';
    for (const ch of nodelist) {
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        segments.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) segments.push(current.trim());

    return segments.map(seg => {
      const match = seg.match(/^(.+?)\[(.+)\]$/);
      if (match) {
        const prefix = match[1];
        const inner = match[2];
        // Split bracket contents and make each part clickable
        const parts = inner.split(',').map(part => {
          const p = part.trim();
          const rangeMatch = p.match(/^(\d+)-(\d+)$/);
          if (rangeMatch) {
            // It's a range like 104-106 — make each number in the range clickable
            const start = parseInt(rangeMatch[1]);
            const end = parseInt(rangeMatch[2]);
            const padLen = rangeMatch[1].length;
            const links = [];
            for (let i = start; i <= end; i++) {
              const num = String(i).padStart(padLen, '0');
              const fullName = prefix + num;
              links.push(`<span class="clickable-node" data-node="${escapeHtml(fullName)}">${num}</span>`);
            }
            return links.join('-');
          } else {
            // Single number like 102
            const fullName = prefix + p;
            return `<span class="clickable-node" data-node="${escapeHtml(fullName)}">${p}</span>`;
          }
        });
        return `${escapeHtml(prefix)}[${parts.join(',')}]`;
      } else {
        // Plain node name
        return `<span class="clickable-node" data-node="${escapeHtml(seg)}">${escapeHtml(seg)}</span>`;
      }
    }).join(', ');
  }

  function jobLink(jobId) {
    if (!jobId) return '';
    return `<span class="clickable-job" data-job="${escapeHtml(jobId)}">${escapeHtml(jobId)}</span>`;
  }

  function filterData(data, term) {
    if (!term) return data;
    const lower = term.toLowerCase();
    return data.filter(row =>
      Object.values(row).some(v => (v || '').toLowerCase().includes(lower))
    );
  }

  // ===== Dashboard =====
  function renderDashboard() {
    // Stats
    const totalNodes = new Set();
    sinfoData.forEach(r => {
      const nodes = (r.nodelist || r.hostnames || '').split(',');
      nodes.forEach(n => { if (n.trim()) totalNodes.add(n.trim()); });
    });
    $('#stat-total-nodes').textContent = sinfoData.reduce((a, r) => a + (parseInt(r.nodes) || 0), 0) || totalNodes.size || '—';

    const runningJobs = squeueAllData.filter(j => (j.state || j.st || '').toLowerCase().includes('running')).length;
    const pendingJobs = squeueAllData.filter(j => (j.state || j.st || '').toLowerCase().includes('pending')).length;
    $('#stat-running-jobs').textContent = runningJobs;
    $('#stat-pending-jobs').textContent = pendingJobs;
    $('#stat-my-jobs').textContent = squeueMeData.length;

    // Node state distribution
    const stateMap = {};
    sinfoData.forEach(r => {
      const st = (r.state || '').toLowerCase().replace(/[*~#!%$@+^]/g, '');
      const count = parseInt(r.nodes) || 1;
      stateMap[st] = (stateMap[st] || 0) + count;
    });
    const totalN = Object.values(stateMap).reduce((a, b) => a + b, 0) || 1;
    const stateColors = {
      idle: 'var(--green)', mixed: 'var(--amber)', allocated: 'var(--blue)',
      alloc: 'var(--blue)', down: 'var(--red)', drain: 'var(--orange)',
      draining: 'var(--orange)', drained: 'var(--orange)',
      reserved: 'var(--cyan)', completing: 'var(--indigo)'
    };

    let barsHtml = '';
    Object.entries(stateMap).sort((a, b) => b[1] - a[1]).forEach(([state, count]) => {
      const pct = (count / totalN * 100).toFixed(1);
      const color = stateColors[state] || 'var(--text-muted)';
      barsHtml += `
        <div class="state-bar-item">
          <span class="state-bar-label">${state || 'unknown'}</span>
          <div class="state-bar-track">
            <div class="state-bar-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <span class="state-bar-count">${count}</span>
        </div>`;
    });
    $('#node-state-bars').innerHTML = barsHtml || '<p style="color:var(--text-muted);font-size:0.85rem">No node data</p>';

    // Dashboard my jobs preview (first 5)
    const preview = squeueMeData.slice(0, 5);
    const cols = getJobColumns();
    $('#dashboard-myjobs').innerHTML = createTable(preview, cols, 'dash-myjobs');
  }

  // ===== Partitions =====
  function renderPartitions(partitions) {
    const container = $('#partition-overview');
    if (!partitions?.length) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">No partition data</p>';
      return;
    }
    container.innerHTML = partitions.map(p => {
      const name = p.PartitionName || 'unknown';
      const state = p.State || 'UP';
      const badgeCls = state === 'UP' ? 'badge-idle' : 'badge-down';
      const nodes = p.TotalNodes || '';
      const maxTime = p.MaxTime || '';
      const isDefault = p.Default === 'YES' ? ' ★' : '';
      return `
        <div class="partition-item">
          <div>
            <span class="partition-name">${escapeHtml(name)}${isDefault}</span>
            <span style="color:var(--text-muted);font-size:0.75rem;margin-left:8px">${nodes} nodes · ${maxTime}</span>
          </div>
          <span class="badge ${badgeCls}">${state}</span>
        </div>`;
    }).join('');
  }

  // ===== Nodes =====
  function renderNodes() {
    const filter = ($('#node-filter')?.value || '').trim();
    const data = filterData(sinfoNodesData, filter);
    const columns = [
      { key: 'nodelist', label: 'Node', render: (val) => {
        if (!val) return '';
        const name = val.trim();
        return `<span class="clickable-node" data-node="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
      }},
      { key: 'partition', label: 'Partition' },
      { key: 'state', label: 'State', render: stateBadge },
      { key: 'cpus', label: 'CPUs' },
      { key: 'memory', label: 'Memory' },
      { key: 'gres', label: 'GRES' },
      { key: 'free_mem', label: 'Free Mem' },
      { key: 'cpu_load', label: 'CPU Load' },
    ];
    const usedCols = columns.filter(c => data.some(r => r[c.key] !== undefined));
    if (usedCols.length === 0 && data.length > 0) {
      const keys = Object.keys(data[0]);
      keys.forEach(k => usedCols.push({ key: k, label: k }));
    }
    $('#nodes-table').innerHTML = createTable(data, usedCols.length ? usedCols : columns, 'nodes');
  }

  // ===== Job Columns =====
  function getJobColumns() {
    return [
      { key: 'jobid', label: 'Job ID', render: jobLink },
      { key: 'name', label: 'Name' },
      { key: 'user', label: 'User' },
      { key: 'partition', label: 'Partition' },
      { key: 'state', label: 'State', render: stateBadge },
      { key: 'time', label: 'Time' },
      { key: 'time_limit', label: 'Limit' },
      { key: 'nodes', label: 'Nodes' },
      { key: 'cpus', label: 'CPUs' },
      { key: 'reason', label: 'Reason' },
      { key: 'submit_time', label: 'Submitted' },
    ];
  }

  function getJobActions(row) {
    const jobId = row.jobid || '';
    const state = (row.state || '').toLowerCase();
    let html = `<button class="action-btn" data-action="details" data-job="${escapeHtml(jobId)}" title="Details">ℹ️</button>`;
    html += `<button class="action-btn" data-action="output" data-job="${escapeHtml(jobId)}" title="View Output">📄</button>`;
    if (state.includes('running') || state.includes('pending')) {
      html += `<button class="action-btn cancel" data-action="cancel" data-job="${escapeHtml(jobId)}" title="Cancel">✕</button>`;
    }
    if (state.includes('pending')) {
      html += `<button class="action-btn hold" data-action="hold" data-job="${escapeHtml(jobId)}" title="Hold">⏸</button>`;
    }
    if (state.includes('running') || state.includes('pending')) {
      html += `<button class="action-btn release" data-action="release" data-job="${escapeHtml(jobId)}" title="Release">▶</button>`;
    }
    return html;
  }

  // ===== My Jobs =====
  function renderMyJobs() {
    const filter = ($('#myjob-filter')?.value || '').trim();
    const data = filterData(squeueMeData, filter);
    const cols = getJobColumns();
    const usedCols = cols.filter(c => data.some(r => r[c.key] !== undefined));
    $('#myjobs-table').innerHTML = createTable(data, usedCols.length ? usedCols : cols, 'myjobs', { actions: getJobActions });
  }

  // ===== All Jobs =====
  function renderAllJobs() {
    const filter = ($('#alljob-filter')?.value || '').trim();
    const data = filterData(squeueAllData, filter);
    const cols = getJobColumns();
    const usedCols = cols.filter(c => data.some(r => r[c.key] !== undefined));
    $('#alljobs-table').innerHTML = createTable(data, usedCols.length ? usedCols : cols, 'alljobs', { actions: getJobActions });
  }

  // ===== History =====
  function renderHistory() {
    const filter = ($('#history-filter')?.value || '').trim();
    const data = filterData(historyData, filter);
    const columns = [
      { key: 'jobid', label: 'Job ID', render: jobLink },
      { key: 'jobname', label: 'Name' },
      { key: 'partition', label: 'Partition' },
      { key: 'account', label: 'Account' },
      { key: 'alloccpus', label: 'CPUs' },
      { key: 'state', label: 'State', render: stateBadge },
      { key: 'exitcode', label: 'Exit' },
      { key: 'elapsed', label: 'Elapsed' },
      { key: 'start', label: 'Start' },
      { key: 'end', label: 'End' },
      { key: 'nodelist', label: 'Nodes', render: nodeLink },
      { key: 'maxrss', label: 'MaxRSS' },
    ];
    const usedCols = columns.filter(c => data.some(r => r[c.key] !== undefined));
    $('#history-table').innerHTML = createTable(data, usedCols.length ? usedCols : columns, 'history');
  }

  // ===== Job Details =====
  function renderJobDetails(details) {
    const container = $('#job-detail-content');
    if (!details || Object.keys(details).length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No details available</p></div>';
    } else {
      container.innerHTML = Object.entries(details).map(([k, v]) => `
        <div class="detail-item">
          <div class="detail-key">${escapeHtml(k)}</div>
          <div class="detail-value">${escapeHtml(v)}</div>
        </div>
      `).join('');
    }
    jobDetailModal.classList.add('active');
  }

  // ===== Node Details =====
  function renderNodeDetails(details) {
    const container = $('#node-detail-content');
    if (!details || Object.keys(details).length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No details available</p></div>';
    } else {
      container.innerHTML = Object.entries(details).map(([k, v]) => `
        <div class="detail-item">
          <div class="detail-key">${escapeHtml(k)}</div>
          <div class="detail-value">${escapeHtml(v)}</div>
        </div>
      `).join('');
    }
    nodeDetailModal.classList.add('active');
  }

  // ===== Job Output =====
  function renderJobOutput(data) {
    if (data.stderr) {
      $('#output-content').textContent = `Error: ${data.stderr}`;
    } else {
      $('#output-content').textContent = data.content || '(empty)';
    }
    // Auto-scroll to bottom
    const pre = $('#output-content');
    pre.scrollTop = pre.scrollHeight;
  }

  // ===== Job Submit =====
  function onJobSubmitted(data) {
    const result = $('#submit-result');
    result.classList.remove('hidden');
    if (data.stderr && !data.stdout) {
      result.className = 'submit-result error';
      result.textContent = data.stderr;
    } else {
      result.className = 'submit-result success';
      result.textContent = data.stdout || 'Job submitted successfully';
    }
    showToast(data.stdout || 'Job submitted', data.stderr ? 'error' : 'success');
  }

  // ===== Templates =====
  const TEMPLATES = {
    basic: `#!/bin/bash
#SBATCH --job-name=my_job
#SBATCH --output=slurm-%j.out
#SBATCH --error=slurm-%j.err
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=8G
#SBATCH --time=01:00:00

echo "Job started on $(hostname) at $(date)"

# Your commands here

echo "Job finished at $(date)"`,
    gpu: `#!/bin/bash
#SBATCH --job-name=gpu_job
#SBATCH --output=slurm-%j.out
#SBATCH --error=slurm-%j.err
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --gres=gpu:1
#SBATCH --time=04:00:00
#SBATCH --partition=gpu

module load cuda

echo "Running on GPU: $CUDA_VISIBLE_DEVICES"

# Your GPU commands here

echo "Job finished at $(date)"`,
    array: `#!/bin/bash
#SBATCH --job-name=array_job
#SBATCH --output=slurm-%A_%a.out
#SBATCH --error=slurm-%A_%a.err
#SBATCH --array=0-9
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=2
#SBATCH --mem=4G
#SBATCH --time=01:00:00

echo "Array task ID: $SLURM_ARRAY_TASK_ID"
echo "Array job ID: $SLURM_ARRAY_JOB_ID"

# Use SLURM_ARRAY_TASK_ID to differentiate tasks

echo "Task $SLURM_ARRAY_TASK_ID finished at $(date)"`,
    mpi: `#!/bin/bash
#SBATCH --job-name=mpi_job
#SBATCH --output=slurm-%j.out
#SBATCH --error=slurm-%j.err
#SBATCH --ntasks=16
#SBATCH --cpus-per-task=1
#SBATCH --mem-per-cpu=2G
#SBATCH --time=02:00:00

module load openmpi

echo "Running MPI job with $SLURM_NTASKS tasks"

srun ./my_mpi_program

echo "Job finished at $(date)"`
  };

  // ===== Event Listeners =====
  function initEventListeners() {
    // Connect form
    connectForm.addEventListener('submit', (e) => {
      e.preventDefault();
      connectError.classList.add('hidden');
      setConnectLoading(true);

      const host = $('#ssh-host').value.trim();
      const port = $('#ssh-port').value;
      const user = $('#ssh-user').value.trim();
      const password = $('#ssh-password').value;
      const privateKey = $('#ssh-key').value.trim();

      wsSend('connect', { host, port, user, password, privateKey: privateKey || undefined });
    });

    // Reconnect
    $('#reconnect-btn').addEventListener('click', () => {
      reconnectModal.classList.remove('active');
      connectModal.classList.add('active');
      setConnectLoading(false);
    });

    // Tab navigation
    $$('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Refresh
    $('#refresh-btn').addEventListener('click', () => {
      wsSend('refresh');
      showToast('Refreshing...', 'info');
    });

    // Disconnect
    $('#disconnect-btn').addEventListener('click', async () => {
      const ok = await showConfirm('Disconnect', 'Are you sure you want to disconnect from the cluster?');
      if (ok) {
        wsSend('disconnect');
        app.classList.add('hidden');
        connectModal.classList.add('active');
      }
    });

    // Close modals
    $('#job-detail-close').addEventListener('click', () => jobDetailModal.classList.remove('active'));
    $('#node-detail-close').addEventListener('click', () => nodeDetailModal.classList.remove('active'));
    $('#output-close').addEventListener('click', () => outputModal.classList.remove('active'));

    // Clicking outside modal content closes it
    [jobDetailModal, nodeDetailModal, outputModal].forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('active');
      });
    });

    // Table sorting (event delegation)
    document.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-table]');
      if (th) {
        const tableId = th.dataset.table;
        const col = parseInt(th.dataset.col);
        const curr = sortState[tableId] || {};
        if (curr.col === col) {
          sortState[tableId] = { col, dir: curr.dir === 'asc' ? 'desc' : 'asc' };
        } else {
          sortState[tableId] = { col, dir: 'asc' };
        }
        // Re-render the right table
        if (tableId === 'nodes') renderNodes();
        else if (tableId === 'myjobs') renderMyJobs();
        else if (tableId === 'alljobs') renderAllJobs();
        else if (tableId === 'history') renderHistory();
        else if (tableId === 'dash-myjobs') renderDashboard();
      }
    });

    // Action buttons (event delegation)
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.action-btn');
      if (!btn) return;
      const action = btn.dataset.action;
      const jobId = btn.dataset.job;

      switch (action) {
        case 'details':
          wsSend('job_details', { jobId });
          break;
        case 'cancel': {
          const ok = await showConfirm('Cancel Job', `Cancel job ${jobId}?`);
          if (ok) wsSend('cancel_job', { jobId });
          break;
        }
        case 'hold':
          wsSend('hold_job', { jobId });
          break;
        case 'release':
          wsSend('release_job', { jobId });
          break;
        case 'output': {
          // Try to guess output file path
          const outputPath = `slurm-${jobId}.out`;
          $('#output-path').value = outputPath;
          outputModal.classList.add('active');
          wsSend('job_output', { filePath: outputPath, lines: 100 });
          break;
        }
      }
    });

    // Node click (event delegation)
    document.addEventListener('click', (e) => {
      const nodeEl = e.target.closest('.clickable-node');
      if (nodeEl) {
        wsSend('node_details', { nodeName: nodeEl.dataset.node });
      }
    });

    // Job ID click (event delegation)
    document.addEventListener('click', (e) => {
      const jobEl = e.target.closest('.clickable-job');
      if (jobEl) {
        wsSend('job_details', { jobId: jobEl.dataset.job });
      }
    });

    // Filters
    ['node-filter', 'myjob-filter', 'alljob-filter', 'history-filter'].forEach(id => {
      const el = $(`#${id}`);
      if (el) {
        el.addEventListener('input', () => {
          if (id === 'node-filter') renderNodes();
          else if (id === 'myjob-filter') renderMyJobs();
          else if (id === 'alljob-filter') renderAllJobs();
          else if (id === 'history-filter') renderHistory();
        });
      }
    });

    // History load
    $('#history-load-btn').addEventListener('click', () => {
      const startDate = $('#history-start').value;
      wsSend('job_history', { startDate: startDate || '2020-01-01' });
      showToast('Loading job history...', 'info');
    });

    // Output viewer
    $('#output-load-btn').addEventListener('click', () => {
      const filePath = $('#output-path').value.trim();
      const lines = parseInt($('#output-lines').value) || 100;
      if (filePath) wsSend('job_output', { filePath, lines });
    });
    $('#output-refresh-btn').addEventListener('click', () => {
      const filePath = $('#output-path').value.trim();
      const lines = parseInt($('#output-lines').value) || 100;
      if (filePath) wsSend('job_output', { filePath, lines });
    });

    // Submit job
    $('#submit-btn').addEventListener('click', () => {
      const script = $('#submit-script').value.trim();
      if (!script) { showToast('Please enter a job script', 'error'); return; }
      wsSend('submit_job', { script });
    });

    // Templates
    $$('[data-template]').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = TEMPLATES[btn.dataset.template];
        if (t) $('#submit-script').value = t;
      });
    });

    // Tab key in script editor
    $('#submit-script').addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const textarea = e.target;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 4;
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        jobDetailModal.classList.remove('active');
        nodeDetailModal.classList.remove('active');
        outputModal.classList.remove('active');
      }
    });
  }

  // ===== Init =====
  function init() {
    initWebSocket();
    initEventListeners();

    // Restore saved credentials
    const saved = loadCredentials();
    if (saved) {
      if (saved.host) $('#ssh-host').value = saved.host;
      if (saved.port) $('#ssh-port').value = saved.port;
      if (saved.user) $('#ssh-user').value = saved.user;
      if (saved.password) $('#ssh-password').value = saved.password;
      if (saved.privateKey) $('#ssh-key').value = saved.privateKey;
      $('#ssh-remember').checked = true;
    }

    // Set default history date to 7 days ago
    const d = new Date();
    d.setDate(d.getDate() - 7);
    const histInput = $('#history-start');
    if (histInput) histInput.value = d.toISOString().slice(0, 10);
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
