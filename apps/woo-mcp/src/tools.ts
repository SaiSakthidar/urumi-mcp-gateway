import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WooClient } from "./woo-client.js";

// The five store tools. Each one is a thin wrapper over one WooCommerce REST
// call; responses are trimmed to the fields a person or an LLM actually needs.

const ORDER_STATUSES = [
  "pending",
  "processing",
  "on-hold",
  "completed",
  "cancelled",
  "refunded",
  "failed",
] as const;

interface WcProduct {
  id: number;
  name: string;
  status: string;
  price: string;
  regular_price: string;
  sale_price: string;
  stock_status: string;
  permalink: string;
}

interface WcOrder {
  id: number;
  number: string;
  status: string;
  date_created: string;
  date_modified: string;
  total: string;
  currency: string;
  payment_method_title: string;
  customer_note: string;
  billing: { first_name: string; last_name: string; email: string; phone: string };
  line_items: { name: string; quantity: number; total: string; product_id: number }[];
}

function summarizeProduct(p: WcProduct) {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    price: p.price,
    regular_price: p.regular_price,
    sale_price: p.sale_price || undefined,
    stock_status: p.stock_status,
    url: p.permalink,
  };
}

function summarizeOrder(o: WcOrder) {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    created: o.date_created,
    total: o.total,
    currency: o.currency,
    customer: `${o.billing.first_name} ${o.billing.last_name}`.trim(),
    email: o.billing.email,
    payment_method: o.payment_method_title,
    items: o.line_items.map((i) => ({ name: i.name, quantity: i.quantity, total: i.total })),
  };
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `WooCommerce error: ${message}` }] };
  }
}

// YYYY-MM-DD for "now minus `daysAgo` days" in the store's timezone.
function dateInTimezone(timeZone: string, daysAgo = 0): string {
  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(when);
}

export function registerTools(server: McpServer, wc: WooClient, storeTimezone: string): void {
  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "List products in the WooCommerce store, newest first. Optionally search by name.",
      inputSchema: {
        search: z.string().optional().describe("Text to search for in product names"),
        status: z.enum(["any", "publish", "draft", "pending", "private"]).default("any"),
        per_page: z.number().int().min(1).max(50).default(20),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true },
    },
    ({ search, status, per_page, page }) =>
      run(async () => {
        const products = await wc.get<WcProduct[]>("/products", { search, status, per_page, page });
        return products.map(summarizeProduct);
      }),
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description: "Create a simple product. Published products appear on the storefront immediately.",
      inputSchema: {
        name: z.string().min(1).describe("Product name"),
        regular_price: z
          .union([z.string(), z.number()])
          .describe("Price in the store currency, e.g. 12.50"),
        description: z.string().optional(),
        status: z.enum(["publish", "draft"]).default("publish"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ name, regular_price, description, status }) =>
      run(async () => {
        const price = String(regular_price).trim();
        if (!/^\d+(\.\d{1,2})?$/.test(price)) {
          throw new Error(`Invalid price "${price}": use a number like 12.50`);
        }
        const product = await wc.post<WcProduct>("/products", {
          name,
          type: "simple",
          regular_price: price,
          description,
          status,
        });
        return summarizeProduct(product);
      }),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        `List orders, newest first. Use date to get the orders placed on one day ` +
        `("today", "yesterday" or YYYY-MM-DD), in the store's timezone (${storeTimezone}).`,
      inputSchema: {
        date: z
          .string()
          .regex(/^(today|yesterday|\d{4}-\d{2}-\d{2})$/)
          .optional()
          .describe('"today", "yesterday" or YYYY-MM-DD'),
        status: z.enum(["any", ...ORDER_STATUSES]).default("any"),
        per_page: z.number().int().min(1).max(50).default(20),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true },
    },
    ({ date, status, per_page, page }) =>
      run(async () => {
        let day: string | undefined;
        if (date === "today") day = dateInTimezone(storeTimezone);
        else if (date === "yesterday") day = dateInTimezone(storeTimezone, 1);
        else day = date;

        // Without dates_are_gmt, WooCommerce reads after/before in the store's timezone.
        const orders = await wc.get<WcOrder[]>("/orders", {
          status,
          per_page,
          page,
          after: day && `${day}T00:00:00`,
          before: day && `${day}T23:59:59`,
        });
        return { date: day, count: orders.length, orders: orders.map(summarizeOrder) };
      }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get one order by its ID, including line items and customer details.",
      inputSchema: {
        id: z.number().int().positive().describe("Order ID"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      run(async () => {
        const o = await wc.get<WcOrder>(`/orders/${id}`);
        return {
          ...summarizeOrder(o),
          modified: o.date_modified,
          phone: o.billing.phone,
          customer_note: o.customer_note || undefined,
        };
      }),
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description: "Change the status of an order, e.g. mark it completed or cancelled.",
      inputSchema: {
        id: z.number().int().positive().describe("Order ID"),
        status: z.enum(ORDER_STATUSES),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ id, status }) =>
      run(async () => {
        const o = await wc.put<WcOrder>(`/orders/${id}`, { status });
        return summarizeOrder(o);
      }),
  );
}
