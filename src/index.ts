#!/usr/bin/env node

/**
 * Strider Labs DoorDash MCP Server
 * 
 * MCP server that gives AI agents the ability to search restaurants,
 * browse menus, add items to cart, place orders, and track deliveries.
 * https://striderlabs.ai
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  checkAuth,
  searchRestaurants,
  getMenu,
  addToCart,
  getCart,
  placeOrder,
  trackOrder,
  setAddress,
  createGroupOrder,
  getLoginUrl,
  cleanup,
} from "./browser.js";
import { hasStoredCookies, clearCookies, getCookiesPath } from "./auth.js";

// Every tool call drives the same singleton browser tab, and the flows are
// stateful across calls (add_to_cart assumes menu already navigated there), so
// concurrent callers must not interleave.
let queue: Promise<unknown> = Promise.resolve();
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

let lastToolAt = 0;
export function noteToolActivity(): void {
  lastToolAt = Date.now();
}

/**
 * Keep an idle session warm. DoorDash cookies go stale in a container nobody
 * is ordering from, and you find out when you are hungry. A beat re-navigates
 * and re-saves the cookies, and logs loudly once the session is beyond saving.
 *
 * Beats are skipped whenever a tool ran during the interval: those already
 * refreshed the cookies, and checkAuth navigates the one shared tab, which
 * would strand a caller midway through menu -> add_to_cart.
 */
export function startHeartbeat(
  hours: number,
  probe: () => Promise<{ isLoggedIn: boolean }> = checkAuth
): void {
  const schedule = () => {
    // +/-25% so the beat is not a metronome DoorDash can pick out.
    const delay = hours * 3600_000 * (0.75 + Math.random() * 0.5);
    setTimeout(async () => {
      if (Date.now() - lastToolAt >= delay) {
        try {
          const { isLoggedIn } = await serialize(probe);
          if (!isLoggedIn) {
            console.error(
              "Heartbeat: DoorDash session is stale. Re-run `npm run login` and restart."
            );
          }
        } catch (error) {
          console.error("Heartbeat failed:", error);
        }
      }
      schedule();
    }, delay).unref();
  };
  schedule();
}

// Tool definitions
const listTools = async () => {
  return {
    tools: [
      {
        name: "doordash_auth_check",
        description:
          "Check if user is logged in to DoorDash. Returns login status and instructions if not authenticated. Call this before any other DoorDash operations.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "doordash_auth_clear",
        description:
          "Clear stored DoorDash session cookies. Use this to log out or reset authentication state.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "doordash_set_address",
        description:
          "Set the delivery address for DoorDash orders. Must be set before searching for restaurants.",
        inputSchema: {
          type: "object",
          properties: {
            address: {
              type: "string",
              description: "Full delivery address (e.g., '123 Main St, San Francisco, CA 94102')",
            },
          },
          required: ["address"],
        },
      },
      {
        name: "doordash_search",
        description:
          "Search for restaurants on DoorDash. Can search by restaurant name, food type, or cuisine.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query (restaurant name, food type, or cuisine)",
            },
            cuisine: {
              type: "string",
              description: "Filter by cuisine type (e.g., 'pizza', 'chinese', 'mexican')",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "doordash_menu",
        description:
          "Get the full menu for a specific restaurant. Returns categories and items with prices.",
        inputSchema: {
          type: "object",
          properties: {
            restaurantId: {
              type: "string",
              description: "The restaurant ID (from search results)",
            },
          },
          required: ["restaurantId"],
        },
      },
      {
        name: "doordash_add_to_cart",
        description:
          "Add a menu item to the cart. Must be on a restaurant page first (use doordash_menu).",
        inputSchema: {
          type: "object",
          properties: {
            restaurantId: {
              type: "string",
              description: "The restaurant ID",
            },
            itemName: {
              type: "string",
              description: "Name of the menu item to add",
            },
            quantity: {
              type: "number",
              description: "Quantity to add (default: 1)",
            },
            specialInstructions: {
              type: "string",
              description: "Special instructions for the item (optional)",
            },
          },
          required: ["restaurantId", "itemName"],
        },
      },
      {
        name: "doordash_cart",
        description:
          "View current cart contents, including items, quantities, and totals.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "doordash_checkout",
        description:
          "Proceed to checkout and optionally place the order. Set confirm=false to preview order details, confirm=true to actually place the order.",
        inputSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              description: "Set to true to actually place the order, false to just preview",
            },
          },
          required: ["confirm"],
        },
      },
      {
        name: "doordash_create_group_order",
        description:
          "Create a group order for a restaurant and return the shareable link others can use to join and add their own items. Requires the delivery address to be set first.",
        inputSchema: {
          type: "object",
          properties: {
            restaurantId: {
              type: "string",
              description: "The restaurant ID to start the group order from (from search results)",
            },
          },
          required: ["restaurantId"],
        },
      },
      {
        name: "doordash_track_order",
        description:
          "Track the status of an order. Shows delivery progress, estimated time, and dasher info if available.",
        inputSchema: {
          type: "object",
          properties: {
            orderId: {
              type: "string",
              description: "Order ID to track (optional - defaults to most recent active order)",
            },
          },
        },
      },
    ],
  };
};

// Tool execution
const callTool = async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "doordash_auth_check": {
        const hasCookies = hasStoredCookies();
        
        if (!hasCookies) {
          const loginInfo = await getLoginUrl();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  isLoggedIn: false,
                  message: "Not logged in to DoorDash.",
                  loginUrl: loginInfo.url,
                  instructions: loginInfo.instructions,
                  cookiesPath: getCookiesPath(),
                }),
              },
            ],
          };
        }
        
        const authState = await checkAuth();
        
        if (!authState.isLoggedIn) {
          const loginInfo = await getLoginUrl();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  isLoggedIn: false,
                  message: "Session expired. Please log in again.",
                  loginUrl: loginInfo.url,
                  instructions: loginInfo.instructions,
                }),
              },
            ],
          };
        }
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                isLoggedIn: true,
                message: "Logged in to DoorDash.",
                email: authState.email,
              }),
            },
          ],
        };
      }

      case "doordash_auth_clear": {
        clearCookies();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "DoorDash session cleared. You will need to log in again.",
              }),
            },
          ],
        };
      }

      case "doordash_set_address": {
        const { address } = args as { address: string };
        const result = await setAddress(address);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      case "doordash_search": {
        const { query, cuisine } = args as { query: string; cuisine?: string };
        const result = await searchRestaurants(query, { cuisine });
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      case "doordash_menu": {
        const { restaurantId } = args as { restaurantId: string };
        const result = await getMenu(restaurantId);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      case "doordash_add_to_cart": {
        const { restaurantId, itemName, quantity, specialInstructions } = args as {
          restaurantId: string;
          itemName: string;
          quantity?: number;
          specialInstructions?: string;
        };
        const result = await addToCart(restaurantId, itemName, quantity, specialInstructions);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      case "doordash_cart": {
        const result = await getCart();
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      case "doordash_checkout": {
        const { confirm } = args as { confirm: boolean };
        const result = await placeOrder(confirm);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      case "doordash_create_group_order": {
        const { restaurantId } = args as { restaurantId: string };
        const result = await createGroupOrder(restaurantId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      case "doordash_track_order": {
        const { orderId } = args as { orderId?: string };
        const result = await trackOrder(orderId);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Unknown tool: ${name}`,
              }),
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: errorMessage,
          }),
        },
      ],
      isError: true,
    };
  }
};

function createServer(): Server {
  const server = new Server(
    {
      name: "strider-doordash",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, listTools);
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    serialize(async () => {
      noteToolActivity();
      try {
        return await callTool(request);
      } finally {
        noteToolActivity();
      }
    })
  );
  return server;
}

// Cleanup on exit
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(0);
});

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Stateless Streamable HTTP: a fresh Server and transport per request. All the
 * real state lives in the browser singleton, not in the MCP session, so there
 * is nothing to keep between requests.
 */
async function serveHttp(port: number) {
  const token = process.env.MCP_HTTP_TOKEN;
  if (!token) {
    console.error("MCP_HTTP_TOKEN is required when MCP_HTTP_PORT is set - this server can spend money.");
    process.exit(1);
  }
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const heartbeatHours = Number(process.env.DOORDASH_HEARTBEAT_HOURS);
  if (heartbeatHours > 0) startHeartbeat(heartbeatHours);

  createHttpServer(async (req, res) => {
    // Unauthenticated so a container probe needs no token. Says only "alive" -
    // it does not check the DoorDash session, which the heartbeat logs about.
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    if (!tokenMatches(req.headers.authorization, token)) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await createServer().connect(transport);
    await transport.handleRequest(req, res);
  }).listen(port, host, () => {
    console.error(`Strider DoorDash MCP server listening on http://${host}:${port}`);
  });
}

async function main() {
  const port = Number(process.env.MCP_HTTP_PORT);
  if (port) {
    await serveHttp(port);
    return;
  }
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error("Strider DoorDash MCP server running");
}

main().catch(console.error);
