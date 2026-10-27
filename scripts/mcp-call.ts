// MCP 서버의 도구를 터미널에서 한 번 불러 본다. 디버깅과 평가용.
//
//   node scripts/mcp-call.ts --list
//   node scripts/mcp-call.ts [--member <회원 ID>] <도구 이름> '<JSON 인자>'
//
// --member를 주면 문의 한 건 모드(그 회원의 주문만 보임)로 서버를 띄운다.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { ROOT } from "../src/config.ts";

const argv = process.argv.slice(2);
let member: string | null = null;
const memberAt = argv.indexOf("--member");
if (memberAt !== -1) {
  member = argv[memberAt + 1] ?? null;
  argv.splice(memberAt, 2);
}

const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);
if (member) {
  env.CS_SCOPE = "inquiry";
  env.CS_MEMBER_ID = member;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`--env-file-if-exists=${path.join(ROOT, ".env")}`, path.join(ROOT, "src/mcp/main.ts")],
  env,
  stderr: "inherit",
});
const client = new Client({ name: "mcp-call", version: "0.1.0" });
await client.connect(transport);

try {
  if (argv[0] === "--list" || argv.length === 0) {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}: ${t.description}`);
  } else {
    const [name, json = "{}"] = argv;
    const result = await client.callTool({ name, arguments: JSON.parse(json) });
    const content = result.content as { type: string; text?: string }[];
    const text = content.map((c) => c.text ?? "").join("\n");
    if (result.isError) {
      console.log(`오류: ${text}`);
      process.exitCode = 1;
    } else {
      console.log(text);
    }
  }
} finally {
  await client.close();
}
