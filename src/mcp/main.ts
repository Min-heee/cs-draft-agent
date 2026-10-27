import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { createCafe24Client, loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { PolicyStore } from "../knowledge/policies.ts";
import { loadSizeCharts } from "../sizing.ts";
import { createMcpServer } from "./server.ts";

// MCP 서버 실행 파일 (stdio). stdout은 MCP 통신에만 쓰므로 여기서 console.log를 쓰면 안 된다.
//
// 문의 한 건 모드:  CS_SCOPE=inquiry CS_MEMBER_ID=<회원 ID> node src/mcp/main.ts
//                   (비회원 문의면 CS_MEMBER_ID 없이 CS_SCOPE=inquiry만 준다)
// 직원 모드:        node src/mcp/main.ts   (DB_FILE의 문의함을 읽고 초안을 저장한다)

const config = loadConfig();
const deps = {
  cafe24: createCafe24Client(config),
  policies: PolicyStore.fromDir(path.join(config.dataDir, "policies")),
  sizeCharts: loadSizeCharts(path.join(config.dataDir, "size-charts.json")),
};
const memberId = process.env.CS_MEMBER_ID?.trim() || null;
const inquiryMode = process.env.CS_SCOPE === "inquiry" || memberId !== null;

const server = createMcpServer(deps, {
  scope: { memberId },
  store: inquiryMode ? undefined : new Store(config.dbFile),
  reviewUrl: `http://localhost:${config.port}`,
});
await server.connect(new StdioServerTransport());
