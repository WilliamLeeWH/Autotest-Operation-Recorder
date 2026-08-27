import http from 'node:http';

export interface StubRequest { model: string; content: any[] | null; }

export async function startVlmStub(responseBody: string): Promise<{
  url: string;
  requests: StubRequest[];
  close: () => Promise<void>;
}> {
  const requests: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed: any = null;
      try {
        parsed = JSON.parse(body);
      } catch {}
      requests.push({
        model: parsed?.model ?? '',
        content: parsed?.messages?.[0]?.content ?? null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // 同桩同时服务 OpenAI 兼容协议（top-level choices.message.content）与 Anthropic 协议（top-level content）
      res.end(
        JSON.stringify({
          choices: [{ message: { content: responseBody } }],
          content: [{ type: 'text', text: responseBody }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}