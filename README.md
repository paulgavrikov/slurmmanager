# Slurm Manager

A web-based Slurm cluster management UI that connects via SSH and provides real-time monitoring and job control.

![Slurm Manager](https://img.shields.io/badge/Slurm-Manager-6366f1?style=for-the-badge)

## Screenshots

| | |
|:---:|:---:|
| ![Login](screenshots/login.png) | ![Dashboard](screenshots/dashboard.png) |
| **SSH Connection** | **Dashboard** |
| ![Nodes](screenshots/nodes.png) | ![Submit Job](screenshots/submit.png) |
| **Nodes** | **Submit Job** |

## Features

- **Dashboard** — Cluster overview with node state distribution, partition info, and job stats
- **Nodes** — Per-node list with state, CPUs, memory, GRES, and CPU load (click any node for details)
- **My Jobs** — Your job queue with cancel, hold, release, view output, and detail actions
- **All Jobs** — Full cluster queue with filtering and sorting
- **Job History** — Past job accounting via `sacct` with configurable date range
- **Submit Job** — Script editor with quick templates (Basic, GPU, Array, MPI)
- **Job Output** — View stdout/stderr logs from job output files
- **Auto-refresh** — Data refreshes every 10 seconds while connected
- **Reconnect** — Automatic disconnect detection with reconnect prompt
- **Remember Me** — Saves connection info to localStorage for quick reconnects

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and enter your cluster's SSH details.

## SSH Authentication

The app supports three authentication methods (in order of priority):

1. **Private key (pasted)** — Paste your key text into the "Private Key" field
2. **Password** — Enter your password in the "Password" field
3. **Auto-detect** — Leave both empty and the server will automatically try keys from `~/.ssh/` (`id_ed25519`, `id_rsa`, `id_ecdsa`, `id_dsa`), then fall back to SSH agent

## Requirements

- **Node.js** ≥ 16
- SSH access to a Slurm cluster

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `SSH_AUTH_SOCK` | (system) | SSH agent socket (used as fallback) |

## Stack

- **Backend**: Node.js, Express, [ssh2](https://github.com/mscdex/ssh2), [ws](https://github.com/websockets/ws)
- **Frontend**: Vanilla HTML/CSS/JS with WebSocket
