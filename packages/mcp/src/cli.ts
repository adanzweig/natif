#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNatifMcpServer } from "./server";

await createNatifMcpServer().connect(new StdioServerTransport());
