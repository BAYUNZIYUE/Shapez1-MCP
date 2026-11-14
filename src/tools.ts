import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { BridgeError, describeError, type GameClient, type Logger } from "./bridge.js";

export interface ToolDeps {
  game: GameClient;
  log?: Logger;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

const failure = (prefix: string, error: unknown): ToolResult => {
  if (error instanceof BridgeError) {
    return { content: [{ type: "text", text: `${prefix}失败（${error.code}）：${error.message}` }], isError: true };
  }
  return { content: [{ type: "text", text: `${prefix}失败：${describeError(error)}` }], isError: true };
};

// 注意：游戏内部的 StaticMapEntity.rotation 是**角度**，且断言必须是 90 的倍数，
// 不是 0..3 的索引（传 1 会报 "Rotation of static map entity must be multiple of 90"）。
const rotationSchema = z
  .number()
  .int()
  .min(0)
  .max(270)
  .multipleOf(90)
  .describe("朝向角度：0=上 90=右 180=下 270=左（顺时针，必须是 90 的倍数）");

const placementSchema = z.object({
  buildingId: z
    .string()
    .min(1)
    .optional()
    .describe("建筑 id（Metabuilding 的 id），如 belt、miner、balancer、cutter；与 code 二选一"),
  code: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe("建筑变体编号（gBuildingVariants 的 key，如 1=Belt 直行）。给 code 时忽略 buildingId/variant/rotationVariant；编号用 shapez_list_buildings 查"),
  x: z.number().int().describe("左上角瓦片 x 坐标（整数）"),
  y: z.number().int().describe("左上角瓦片 y 坐标（整数）"),
  rotation: rotationSchema.optional(),
  variant: z.string().optional().describe("变体名（字符串），如 default、chainable，默认 default"),
  rotationVariant: z.number().int().min(0).optional().describe("方向变体索引，默认 0（传送带 0=直行 1=左转 2=右转）"),
});

const layerSchema = z.enum(["regular", "wires"]).describe("层：regular（普通）或 wires（电线层）");

/**
 * 工具定义表。与 MCP server 解耦，便于单测直接调用 handler（不经过 stdio 传输）。
 * 工具层只做参数校验与错误包装，真正的游戏交互全部在 mod 侧，
 * 这样游戏 API 变动时只需要改 mod/shapez1-mcp.js。
 */
export function buildTools(deps: ToolDeps): ToolSpec[] {
  const { game } = deps;
  const call = (method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> =>
    game.call(method, params, timeoutMs);

  return [
    {
      name: "shapez_status",
      description:
        "查询 shapez 游戏当前状态：mod 是否连上、是否已加载存档、游戏版本、暂停/速度、当前层、相机位置。任何操作前先调用一次确认连接。",
      inputSchema: z.object({}),
      handler: async () => {
        const bridge = game.getStatus();
        if (!bridge.connected) {
          return ok({
            bridge,
            game: null,
            hint: "游戏未连接：确认 shapez 桌面版（Steam/itch 版）在运行，且 mod 已放进 mods 目录并重启过游戏",
          });
        }
        try {
          return ok({ bridge, game: await call("status") });
        } catch (error) {
          return failure("查询游戏状态", error);
        }
      },
    },
    {
      name: "shapez_list_buildings",
      description:
        "列出游戏里全部可放置建筑变体：code（放进 place 时的编号）、buildingId、variant、rotationVariant、占地尺寸。放置建筑前先调这个拿准确编号，不要猜 id。",
      inputSchema: z.object({}),
      handler: async () => {
        try {
          return ok(await call("listBuildings"));
        } catch (error) {
          return failure("列出建筑", error);
        }
      },
    },
    {
      name: "shapez_place_building",
      description:
        "在指定瓦片放置一个建筑（直接调用游戏内部建造接口，等同玩家手动放置，但不会自动进入多连放）。用 buildingId+variant 或 code 指定建筑，id 要先用 shapez_list_buildings 查。返回新实体的 uid；位置非法或被占用时返回 ok=false。",
      inputSchema: placementSchema,
      handler: async (args) => {
        try {
          return ok(await call("placeBuilding", args));
        } catch (error) {
          return failure("放置建筑", error);
        }
      },
    },
    {
      name: "shapez_place_buildings",
      description:
        "批量放置建筑，在游戏内用 bulkOperation 包裹执行（几千个也不会卡死）。单条失败不影响其余条目，返回值里列出失败索引与原因。",
      inputSchema: z.object({
        buildings: z.array(placementSchema).min(1).max(5000).describe("要放置的建筑列表"),
      }),
      handler: async (args) => {
        try {
          return ok(await call("placeBuildings", args, 120_000));
        } catch (error) {
          return failure("批量放置建筑", error);
        }
      },
    },
    {
      name: "shapez_delete_building",
      description: "删除指定瓦片上的建筑（按当前层或指定层）。返回被删除建筑的 uid 与类型。",
      inputSchema: z.object({
        x: z.number().int(),
        y: z.number().int(),
        layer: layerSchema.optional().describe("层，默认当前层"),
      }),
      handler: async (args) => {
        try {
          return ok(await call("deleteBuilding", args));
        } catch (error) {
          return failure("删除建筑", error);
        }
      },
    },
    {
      name: "shapez_query_entities",
      description:
        "查询地图上的建筑实体，可按矩形范围、层、建筑类型过滤。坐标是瓦片坐标，范围为闭区间；不传范围则扫描全图（较慢，务必带 limit）。",
      inputSchema: z.object({
        x1: z.number().int().optional(),
        y1: z.number().int().optional(),
        x2: z.number().int().optional(),
        y2: z.number().int().optional(),
        layer: layerSchema.optional().describe("层，不传则所有层"),
        buildingId: z.string().min(1).optional().describe("只返回该建筑 id 的实体"),
        limit: z.number().int().min(1).max(2000).default(200).describe("最多返回条数，默认 200"),
      }),
      handler: async (args) => {
        try {
          return ok(await call("queryEntities", args, 60_000));
        } catch (error) {
          return failure("查询实体", error);
        }
      },
    },
    {
      name: "shapez_query_resources",
      description:
        "扫描地图底层的资源（矿）分布：返回每格资源的形状短码与各形状格数。放 miner 之前先查这个，miner 只能放在有资源的格子上。默认扫相机周围 32 格半径，单次最多 65536 格。",
      inputSchema: z.object({
        x: z.number().int().optional().describe("扫描中心 x（默认相机中心）"),
        y: z.number().int().optional().describe("扫描中心 y（默认相机中心）"),
        radius: z.number().int().min(1).max(128).optional().describe("正方形半径，默认 32"),
        x1: z.number().int().optional(),
        y1: z.number().int().optional(),
        x2: z.number().int().optional(),
        y2: z.number().int().optional(),
        limit: z.number().int().min(1).max(5000).default(2000).describe("最多列出多少格，默认 2000"),
      }),
      handler: async (args) => {
        try {
          return ok(await call("queryResources", args, 60_000));
        } catch (error) {
          return failure("扫描资源", error);
        }
      },
    },
    {
      name: "shapez_inspect_tile",
      description:
        "看单个格子：上面的建筑（id/位置/方向）、底层资源，以及如果是传送带时带上的物品（形状与距离）。用于验证自动放置后物料是否真的在流动。",
      inputSchema: z.object({
        x: z.number().int(),
        y: z.number().int(),
        layer: layerSchema.optional(),
      }),
      handler: async (args) => {
        try {
          return ok(await call("inspectTile", args));
        } catch (error) {
          return failure("查看格子", error);
        }
      },
    },
    {
      name: "shapez_hub_goals",
      description: "读取 Hub 升级目标：当前目标进度、已交付数量、各级升级等级、Hub 内已存形状。",
      inputSchema: z.object({}),
      handler: async () => {
        try {
          return ok(await call("hubGoals"));
        } catch (error) {
          return failure("读取 Hub 目标", error);
        }
      },
    },
    {
      name: "shapez_production_rates",
      description: "读取生产统计：各形状的当前产出速率与历史平均速率（游戏内 productionAnalytics 数据）。",
      inputSchema: z.object({}),
      handler: async () => {
        try {
          return ok(await call("productionRates"));
        } catch (error) {
          return failure("读取生产速率", error);
        }
      },
    },
    {
      name: "shapez_decode_shape",
      description:
        "把游戏的形状短码（如 CuCuCuCu、RuRu----:CuCu----）解析成四层结构：每层 4 个象限，每象限给出 subShape 与 color，空位为 null。",
      inputSchema: z.object({
        key: z.string().min(1).describe("形状短码，大小写敏感"),
      }),
      handler: async (args) => {
        try {
          return ok(await call("decodeShape", args));
        } catch (error) {
          return failure("解析形状", error);
        }
      },
    },
    {
      name: "shapez_set_speed",
      description: "设置游戏速度：paused 暂停、regular 正常、fast_forward 快进。仅当前会话有效，不写入存档。",
      inputSchema: z.object({
        mode: z.enum(["paused", "regular", "fast_forward"]),
      }),
      handler: async (args) => {
        try {
          return ok(await call("setSpeed", args));
        } catch (error) {
          return failure("设置游戏速度", error);
        }
      },
    },
    {
      name: "shapez_wait_ticks",
      description:
        "等待游戏推进若干逻辑 tick（按当前速度换算为真实等待时间，最长 60 秒）。用于放置传送带后等物料到位再读取状态。",
      inputSchema: z.object({
        ticks: z.number().int().min(1).max(20_000).default(60),
      }),
      handler: async (args) => {
        try {
          return ok(await call("waitTicks", args, 65_000));
        } catch (error) {
          return failure("等待 tick", error);
        }
      },
    },
  ];
}

/** 注册全部 MCP 工具。 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const tools = buildTools(deps);
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: unknown) => await tool.handler((args ?? {}) as Record<string, unknown>),
    );
  }
  deps.log?.(`[tools] 已注册 ${tools.length} 个工具`);
}
