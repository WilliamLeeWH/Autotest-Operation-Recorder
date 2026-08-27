import http from 'node:http';

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>demo</title></head>
<body>
  <h1>登录页</h1>
  <input id="username" placeholder="用户名" />
  <input id="password" type="password" placeholder="密码" />
  <button id="login">登录</button>
</body></html>`;

export async function startPageServer(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return { url: `http://127.0.0.1:${actualPort}`, close: () => new Promise((r) => server.close(() => r())) };
}