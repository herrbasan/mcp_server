# Remote MCP Server Setup

## Running on a Separate Machine

### 1. On the Server Machine

Update `.env` to allow remote connections:
```bash
MCP_HOST=0.0.0.0
MCP_PORT=3100
```

Start the HTTP server:
```bash
npm run start:http
```

The server will display:
```
🚀 MCP Server listening on http://0.0.0.0:3100
📡 MCP endpoint: http://0.0.0.0:3100/mcp
```

### 2. On Your VS Code Client Machine

Add to `%APPDATA%\Code\User\mcp.json` (VS Code user-level MCP config):

```json
{
  "servers": {
    "mcp-server-orchestrator": {
      "type": "sse",
      "url": "http://192.168.1.100:3100/mcp"
    }
  }
}
```

Replace `192.168.1.100` with your server's IP address.

### 3. Verify Connection

On the server, check health:
```bash
curl http://localhost:3100/health
```

From the client machine:
```bash
curl http://192.168.1.100:3100/health
```

## Firewall Configuration

**Windows Server:**
```powershell
New-NetFirewallRule -DisplayName "MCP Server" -Direction Inbound -LocalPort 3100 -Protocol TCP -Action Allow
```

**Linux Server:**
```bash
sudo ufw allow 3100/tcp
```

## Security Notes

- The MCP endpoint has **no authentication** by default
- Only run on trusted networks
- Consider using SSH tunneling for public networks:
  ```bash
  ssh -L 3100:localhost:3100 user@server
  ```
  Then use `http://localhost:3100/mcp` in VS Code

## Local vs Remote

This repo runs as a remote HTTP MCP service. Use `npm run start:http` and connect VS Code to `/mcp`.
