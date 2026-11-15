/**
 * Shapez1-MCP —— 游戏内桥接 mod（单文件，无外部依赖）
 *
 * 安装：
 *   1. 把本文件复制到 shapez 的 mods 目录
 *        Windows: %APPDATA%\shapez.io\mods
 *        macOS:   ~/Library/Preferences/shapez.io/mods
 *        Linux:   ~/.local/share/shapez.io/mods
 *   2. 重启游戏（mod 只在启动时扫描，热改无效；开发时用 --dev 启动项 + 菜单 Restart）
 *   3. 本机跑 `npm start`（Shapez1-MCP 仓库），游戏会自动连上 ws://127.0.0.1:8765
 *
 * 仅桌面版（Steam / itch / GOG）有效：网页版没有 window.shapez，也不会加载 mod。
 * 有 mod 时 Steam 成就与统计会被游戏关闭，这是游戏自身行为。
 *
 * 协议：见仓库 src/protocol.ts。本文件不能 import，字段必须与那边手工保持一致。
 */
var METADATA = {
  id: "shapez1-mcp",
  name: "Shapez1 MCP Bridge",
  version: "0.2.0",
  author: "BAYUNZIYUE",
  description: "把游戏状态通过本地 WebSocket 暴露给 MCP server，供 agent 基座读写游戏",
  website: "https://github.com/BAYUNZIYUE/Shapez1-MCP",
  minimumGameVersion: ">=1.5.0",
  // 不声明 doesNotAffectSavegame：agent 会放/删建筑，存档一定被改，卸掉 mod 前要提醒玩家
};

/** 与本机 MCP server 的衔接配置。
 *  url 留空 = 自动连 ws://<当前页面主机>:port —— 远程部署（游戏从服务器打开）时自动指向该服务器。
 *  非回环地址**必须**同时配 token，否则 mod 拒绝连接（见 assertSafeUrl）。
 */
var CONFIG = {
  url: "",
  port: 8765,
  token: "",
  reconnectDelayMs: 3000,
  helloTimeoutMs: 5000,
};

var PROTOCOL_VERSION = 1;

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** 解析出实际 WS 地址；非回环且没配 token 直接抛错，避免把有 ipcRenderer 权限的 mod 暴露到局域网。 */
function resolveUrl() {
  var url = CONFIG.url;
  if (!url) {
    url = "ws://" + (window.location.hostname || "127.0.0.1") + ":" + CONFIG.port;
  }
  var match = /^ws:\/\/([^/:]+)(:\d+)?$/.exec(url);
  if (!match) {
    throw new Error("Shapez1-MCP: WS 地址不合法: " + url);
  }
  if (!isLoopbackHost(match[1]) && !CONFIG.token) {
    throw new Error(
      "Shapez1-MCP: 目标不是本机回环地址（" + match[1] + "），必须同时配置 CONFIG.token 与 SHAPEZ1_MCP_TOKEN",
    );
  }
  return url;
}

/** 把物品（BaseItem）转成形状短码；不同来源的物品暴露面不完全一样，逐级兜底。 */
function itemKey(item) {
  if (!item) {
    return null;
  }
  try {
    if (typeof item.getHash === "function") {
      var hash = item.getHash();
      if (hash !== undefined && hash !== null) {
        return String(hash);
      }
    }
  } catch (error) {
    /* 继续兜底 */
  }
  try {
    if (item.definition && typeof item.definition.getHash === "function") {
      return String(item.definition.getHash());
    }
  } catch (error) {
    /* 继续兜底 */
  }
  try {
    if (item.key !== undefined && item.key !== null) {
      return String(item.key);
    }
  } catch (error) {
    /* 放弃 */
  }
  return null;
}

/** 仅用于诊断：拿不到短码时把类型名报出来，方便定位游戏内部结构。 */
function itemType(item) {
  try {
    return (item && item.constructor && item.constructor.name) || typeof item;
  } catch (error) {
    return "unknown";
  }
}

/** 瓦片坐标 → 朝向角度（0=上 90=右 180=下 270=左，与游戏一致）。 */
function angleBetween(from, to) {
  var dx = to.x - from.x;
  var dy = to.y - from.y;
  if (dx === 0 && dy < 0) return 0;
  if (dx > 0 && dy === 0) return 90;
  if (dx === 0 && dy > 0) return 180;
  if (dx < 0 && dy === 0) return 270;
  return null;
}

function errorPayload(error) {
  return {
    code: (error && error.code) || "mod_error",
    message: error && error.message ? error.message : String(error),
  };
}

/**
 * 把任意游戏对象转成可 JSON 化的普通结构。
 * 形状体系可能被 mod（如 Twelvefold）改成 12 象限、带接缝等，所以不能假设字段，
 * 只能按「有 getHash 就报 hash、有 quadrant 数组就展开」这种结构性规则来转。
 */
function safeDump(value, depth, seen) {
  var d = depth || 0;
  var visited = seen || [];
  if (value === null || value === undefined) {
    return value === undefined ? null : value;
  }
  var t = typeof value;
  if (t === "number" || t === "boolean" || t === "string") {
    return value;
  }
  if (t === "function") {
    return "[function " + (value.name || "anonymous") + "]";
  }
  if (t === "symbol" || t === "bigint") {
    return String(value);
  }
  if (visited.length > 40 || visited.indexOf(value) >= 0) {
    return "[circular]";
  }
  if (d > 5) {
    return "[depth]";
  }
  var next = visited.concat([value]);
  if (Array.isArray(value)) {
    return value.slice(0, 12).map(function (entry) {
      return safeDump(entry, d + 1, next);
    });
  }
  if (value instanceof Map) {
    var mapOut = {};
    var mapCount = 0;
    value.forEach(function (v, k) {
      if (mapCount++ < 20) mapOut[String(k)] = safeDump(v, d + 1, next);
    });
    return { __map: mapOut };
  }
  if (value instanceof Set) {
    return { __set: Array.from(value).slice(0, 12).map(function (entry) {
      return safeDump(entry, d + 1, next);
    }) };
  }
  var out = {};
  try {
    if (typeof value.getHash === "function") {
      out.__shape = String(value.getHash());
    }
  } catch (error) {
    /* 不是形状 */
  }
  try {
    if (value.definition && typeof value.definition.getHash === "function") {
      out.__definition = String(value.definition.getHash());
    }
  } catch (error) {
    /* 不是物品 */
  }
  try {
    if (value.constructor && value.constructor.name) {
      out.__type = value.constructor.name;
    }
  } catch (error) {
    /* 忽略 */
  }
  var keys = [];
  try {
    keys = Object.keys(value);
  } catch (error) {
    keys = [];
  }
  for (var i = 0; i < keys.length && i < 40; i++) {
    var key = keys[i];
    if (out[key] !== undefined) continue;
    var field;
    try {
      field = value[key];
    } catch (error) {
      continue;
    }
    if (typeof field === "function") continue;
    out[key] = safeDump(field, d + 1, next);
  }
  return out;
}

class Mod extends shapez.Mod {
  init() {
    this.root = null;
    this.socket = null;
    this.greeted = false;
    this.connectedAt = null;
    this.reconnectTimer = null;
    this.disposed = false;
    this.helloOk = false;

    this.signals.gameStarted.add((root) => {
      this.root = root;
      this.emit("gameStarted", {});
    });
    this.signals.gameDeserialized.add((root) => {
      this.root = root;
      this.emit("gameDeserialized", {});
    });

    this.wsUrl = resolveUrl();
    this.connect();
  }

  // ---------------------------------------------------------------- 连接管理

  connect() {
    if (this.disposed) {
      return;
    }
    var socket;
    try {
      socket = new WebSocket(this.wsUrl);
    } catch (error) {
      this.log("建立连接失败: " + errorPayload(error).message);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.greeted = false;

    var helloTimeout = setTimeout(() => {
      if (!this.greeted && socket.readyState === WebSocket.OPEN) {
        this.log("桥没有回 hello-ok，断开重试");
        socket.close();
      }
    }, CONFIG.helloTimeoutMs);

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          modVersion: METADATA.version,
          token: CONFIG.token,
        }),
      );
    };

    socket.onmessage = (event) => {
      clearTimeout(helloTimeout);
      this.handleMessage(event.data);
    };

    socket.onclose = () => {
      clearTimeout(helloTimeout);
      if (this.socket === socket) {
        this.socket = null;
        this.greeted = false;
        this.helloOk = false;
        this.connectedAt = null;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose 紧随其后，重连逻辑只在 onclose 里做
    };
  }

  scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, CONFIG.reconnectDelayMs);
  }

  log(message) {
    console.warn("[Shapez1-MCP] " + message);
  }

  emit(event, data) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.helloOk) {
      return;
    }
    this.socket.send(JSON.stringify({ type: "event", event: event, data: data }));
  }

  handleMessage(raw) {
    var message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      this.log("收到非 JSON 消息，忽略");
      return;
    }

    if (message.type === "hello-ok") {
      this.helloOk = true;
      this.connectedAt = Date.now();
      this.log("已连上 MCP 桥 " + this.wsUrl);
      return;
    }

    if (message.type !== "request") {
      return;
    }

    var self = this;
    Promise.resolve()
      .then(() => self.dispatch(message.method, message.params || {}))
      .then(
        (result) => self.respond(message.id, true, result),
        (error) => self.respond(message.id, false, null, errorPayload(error)),
      );
  }

  respond(id, ok, result, error) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    var payload = { type: "response", id: id, ok: ok };
    if (ok) {
      payload.result = result === undefined ? null : result;
    } else {
      payload.error = error;
    }
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (sendError) {
      this.log("回包失败: " + errorPayload(sendError).message);
    }
  }

  // ------------------------------------------------------------------ 分发

  dispatch(method, params) {
    var handler = this.methods[method];
    if (!handler) {
      var notImplemented = new Error("mod 不支持该方法: " + method);
      notImplemented.code = "method_not_found";
      throw notImplemented;
    }
    return handler.call(this, params);
  }

  // ------------------------------------------------------------------ 读接口

  status() {
    var result = {
      hasSave: !!this.root,
      modVersion: METADATA.version,
      connectedAt: this.connectedAt,
      uptimeMs: this.connectedAt ? Date.now() - this.connectedAt : null,
    };
    if (!this.root) {
      return result;
    }
    var root = this.root;
    try {
      result.gameVersion = typeof G_BUILD_VERSION === "string" ? G_BUILD_VERSION : null;
    } catch (error) {
      result.gameVersion = null;
    }
    try {
      result.pausedByHud = !!root.hud.shouldPauseGame();
      var unlock = root.hud.parts && root.hud.parts.unlockNotification;
      result.unlockDialogVisible = !!(unlock && unlock.visible);
    } catch (error) {
      result.pausedByHud = null;
    }
    try {
      result.speed = root.time && root.time.speed && root.time.speed.constructor.name;
      result.paused = !!(root.time && root.time.speed && root.time.speed.getTimeMultiplier() === 0);
    } catch (error) {
      result.speed = null;
      result.paused = null;
    }
    result.currentLayer = root.currentLayer;
    try {
      result.camera = {
        x: root.camera.center.x,
        y: root.camera.center.y,
        zoom: root.camera.zoomLevel,
      };
    } catch (error) {
      result.camera = null;
    }
    try {
      result.entityCount = this.collectEntities().length;
    } catch (error) {
      result.entityCount = null;
    }
    return result;
  }

  queryEntities(params) {
    var root = this.requireRoot();
    var limit = params.limit === undefined ? 200 : params.limit;
    var bounds = null;
    if (params.x1 !== undefined || params.y1 !== undefined || params.x2 !== undefined || params.y2 !== undefined) {
      bounds = {
        x1: params.x1 === undefined ? -Infinity : params.x1,
        y1: params.y1 === undefined ? -Infinity : params.y1,
        x2: params.x2 === undefined ? Infinity : params.x2,
        y2: params.y2 === undefined ? Infinity : params.y2,
      };
    }

    var matched = [];
    var total = 0;
    var all = this.collectEntities();
    for (var i = 0; i < all.length; i++) {
      var info = this.describeEntity(all[i]);
      if (!info) {
        continue;
      }
      if (params.buildingId && info.buildingId !== params.buildingId) {
        continue;
      }
      if (params.layer && info.layer !== params.layer) {
        continue;
      }
      if (bounds && !intersects(info, bounds)) {
        continue;
      }
      total += 1;
      if (matched.length < limit) {
        matched.push(info);
      }
    }

    return { total: total, truncated: total > matched.length, entities: matched, layer: root.currentLayer };
  }

  hubGoals() {
    var hub = this.requireRoot().hubGoals;
    var result = {
      level: hub.level,
      levelCount:
        this.root && this.root.gameMode && this.root.gameMode.getLevelDefinitions
          ? this.root.gameMode.getLevelDefinitions().length
          : null,
      delivered: null,
      required: null,
      throughputOnly: null,
      stored: [],
      upgrades: {},
    };

    try {
      result.delivered = hub.getCurrentGoalDelivered();
    } catch (error) {
      result.deliveredError = errorPayload(error).message;
    }
    try {
      if (hub.currentGoal) {
        result.required = hub.currentGoal.required;
        result.throughputOnly = !!hub.currentGoal.throughputOnly;
        result.goalShape = hub.currentGoal.definition ? hub.currentGoal.definition.getHash() : null;
      }
    } catch (error) {
      result.goalError = errorPayload(error).message;
    }
    try {
      var stored = hub.storedShapes || {};
      for (var key in stored) {
        if (Object.prototype.hasOwnProperty.call(stored, key)) {
          result.stored.push({ key: key, amount: stored[key] });
        }
      }
    } catch (error) {
      result.stored = [];
    }
    try {
      var rewards = shapez.enumHubGoalRewards || {};
      var unlocked = [];
      for (var rewardKey in rewards) {
        if (Object.prototype.hasOwnProperty.call(rewards, rewardKey)) {
          try {
            if (hub.isRewardUnlocked(rewards[rewardKey])) {
              unlocked.push(rewardKey);
            }
          } catch (error) {
            /* 单个奖励查询失败不影响整体 */
          }
        }
      }
      result.unlockedRewards = unlocked;
    } catch (error) {
      result.unlockedRewards = null;
    }
    try {
      var levels = hub.upgradeLevels || {};
      var improvements = hub.upgradeImprovements || {};
      for (var id in levels) {
        if (Object.prototype.hasOwnProperty.call(levels, id)) {
          result.upgrades[id] = { level: levels[id], improvement: improvements[id] };
        }
      }
    } catch (error) {
      result.upgrades = {};
    }
    return result;
  }

  productionRates() {
    var analytics = this.requireRoot().productionAnalytics;
    var result = { produced: null, stored: null, delivered: null, unit: "每种形状在最近一个统计切片内的数量（不是每秒）" };
    var sources = ["produced", "stored", "delivered"];
    for (var i = 0; i < sources.length; i++) {
      var source = sources[i];
      try {
        result[source] = toPlain(analytics.getCurrentShapeRatesRaw(source));
      } catch (error) {
        result[source + "Error"] = errorPayload(error).message;
      }
    }
    return result;
  }

  decodeShape(params) {
    var key = params.key;
    if (typeof key !== "string" || key.length === 0) {
      return { valid: false, reason: "key 必须是非空字符串" };
    }
    var definition;
    try {
      definition = shapez.ShapeDefinition.fromShortKey(key);
    } catch (error) {
      return { valid: false, reason: errorPayload(error).message };
    }
    var layers = [];
    var quadrantCount = null;
    for (var layerIndex = 0; layerIndex < definition.layers.length; layerIndex++) {
      var layer = definition.layers[layerIndex];
      // 原版每层是 4 象限数组；Twelvefold 这类 mod 会改成 12 象限（或更多），
      // 所以象限数从数据本身读，不能写死 4。
      var source = layer && layer.quadrants ? layer.quadrants : layer;
      var count = source && typeof source.length === "number" ? source.length : 4;
      if (quadrantCount === null) {
        quadrantCount = count;
      }
      var quadrants = [];
      for (var quadrant = 0; quadrant < count; quadrant++) {
        var subShape = source && source[quadrant];
        if (!subShape) {
          quadrants.push(null);
          continue;
        }
        var entry = {
          subShape: String(subShape.subShape),
          color: String(subShape.color),
        };
        // 额外字段（接缝/边界等）原样带出来，方便判断 mod 的形状语义
        try {
          var extraKeys = Object.keys(subShape);
          for (var extra = 0; extra < extraKeys.length && extra < 10; extra++) {
            var extraKey = extraKeys[extra];
            if (extraKey === "subShape" || extraKey === "color") continue;
            var extraValue = subShape[extraKey];
            if (typeof extraValue === "function" || extraValue === undefined) continue;
            entry[extraKey] = safeDump(extraValue, 3, []);
          }
        } catch (error) {
          /* 额外字段读不到就跳过 */
        }
        quadrants.push(entry);
      }
      layers.push(quadrants);
    }
    return {
      valid: true,
      key: key,
      hash: definition.getHash(),
      quadrantCount: quadrantCount,
      layerCount: definition.layers.length,
      layers: layers,
    };
  }

  /**
   * 在游戏上下文里执行一小段 JS —— 只给只读上下文（shapez/root/hub/map/params/dump），
   * 用来适配被其它 mod 改过的形状/建筑体系：查建筑定义、读机器内部状态、试算法。
   * 不提供 window/fetch/require，返回值统一走 safeDump。
   */
  evalCode(params) {
    var code = params.code;
    if (typeof code !== "string" || !code.trim()) {
      return { ok: false, reason: "code 必须是非空字符串" };
    }
    var root = this.requireRoot();
    var fn;
    try {
      fn = new Function("shapez", "root", "hub", "map", "params", "dump", code);
    } catch (error) {
      return { ok: false, reason: "代码语法错误: " + errorPayload(error).message };
    }
    var started = Date.now();
    var value;
    try {
      value = fn(shapez, root, root.hubGoals, root.map, params, safeDump);
    } catch (error) {
      return {
        ok: false,
        reason: errorPayload(error).message,
        stack: String((error && error.stack) || "").split("\n").slice(0, 6).join("\n"),
      };
    }
    return { ok: true, elapsedMs: Date.now() - started, value: safeDump(value, 0, []) };
  }

  queryResources(params) {
    var root = this.requireRoot();
    var center = root.camera && root.camera.center ? root.camera.center : { x: 0, y: 0 };
    var cx = params.x === undefined ? Math.round(center.x) : params.x;
    var cy = params.y === undefined ? Math.round(center.y) : params.y;
    var half = params.radius === undefined ? 32 : Math.max(1, Math.min(128, params.radius));
    var x1 = params.x1 === undefined ? cx - half : params.x1;
    var y1 = params.y1 === undefined ? cy - half : params.y1;
    var x2 = params.x2 === undefined ? cx + half : params.x2;
    var y2 = params.y2 === undefined ? cy + half : params.y2;
    if ((x2 - x1 + 1) * (y2 - y1 + 1) > 65536) {
      throw new Error("扫描范围超过 65536 格，请缩小范围（用 radius 或 x1..y2）");
    }

    var tiles = [];
    var counts = {};
    var limit = params.limit === undefined ? 2000 : params.limit;
    for (var x = x1; x <= x2; x++) {
      for (var y = y1; y <= y2; y++) {
        var item = null;
        try {
          item = root.map.getLowerLayerContentXY(x, y);
        } catch (error) {
          item = null;
        }
        if (!item) {
          continue;
        }
        var key = itemKey(item);
        counts[key] = (counts[key] || 0) + 1;
        if (tiles.length < limit) {
          tiles.push({ x: x, y: y, shape: key, type: key === null ? itemType(item) : undefined });
        }
      }
    }
    return {
      bounds: { x1: x1, y1: y1, x2: x2, y2: y2 },
      scanned: (x2 - x1 + 1) * (y2 - y1 + 1),
      truncated: Object.keys(counts).length > 0 && tiles.length >= limit,
      counts: counts,
      tiles: tiles,
    };
  }

  inspectTile(params) {
    var root = this.requireRoot();
    var layer = params.layer || root.currentLayer;
    var result = { x: params.x, y: params.y, layer: layer, building: null, resource: null, belt: null };
    try {
      var resource = root.map.getLowerLayerContentXY(params.x, params.y);
      result.resource = itemKey(resource);
      if (result.resource === null && resource) {
        result.resourceType = itemType(resource);
      }
    } catch (error) {
      result.resource = null;
    }
    var entity = root.map.getLayerContentXY(params.x, params.y, layer);
    if (!entity) {
      return result;
    }
    result.building = this.describeEntity(entity);
    try {
      var beltComp = entity.components && entity.components.Belt;
      if (beltComp && beltComp.assignedPath) {
        var slots = [];
        var raw = beltComp.assignedPath.items || [];
        for (var i = 0; i < raw.length && i < 50; i++) {
          var entry = raw[i];
          var item = entry[1];
          slots.push({
            distance: entry[0],
            shape: itemKey(item),
            type: itemKey(item) === null ? itemType(item) : undefined,
          });
        }
        result.belt = { items: slots, spacingToFirstItem: beltComp.assignedPath.spacingToFirstItem };
      }
    } catch (error) {
      result.beltError = errorPayload(error).message;
    }
    return result;
  }

  /**
   * 沿给定的格子序列铺一条传送带，自动挑直行/左转/右转变体。
   * 游戏里旋转是角度（0/90/180/270），弯带用 rotationVariant 1/2 表示：
   *   弯带：实体 rotation = 进入方向，variant 2 出口 = 进入方向 + 90°，variant 1 出口 = 进入方向 - 90°。
   */
  buildBeltPath(params) {
    var root = this.requireRoot();
    var cells = params.cells;
    if (!Array.isArray(cells) || cells.length === 0) {
      throw new Error("cells 必须是非空格子数组");
    }
    var meta = shapez.gMetaBuildingRegistry.findById("belt");
    var layer = params.layer || root.currentLayer;
    var target = params.target || null;
    var from = params.from || null;
    var placed = 0;
    var failed = [];

    root.logic.performBulkOperation(() => {
      for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        var prev = i > 0 ? cells[i - 1] : null;
        var next = i + 1 < cells.length ? cells[i + 1] : target;
        var din = prev ? angleBetween(prev, cell) : i === 0 && from ? angleBetween(from, cell) : null;
        var dout = next ? angleBetween(cell, next) : null;

        var rotation;
        var rotationVariant = 0;
        if (din === null && dout !== null) {
          rotation = dout;
        } else if (dout === null) {
          rotation = din === null ? 0 : din;
        } else if (din === dout) {
          rotation = din;
        } else {
          // 弯带的入口侧 = 实体 rotation，出口 = rotation ± 90（variant 2 是 +90，variant 1 是 -90）
          rotation = din;
          rotationVariant = dout === (din + 270) % 360 ? 1 : 2;
        }

        var entity = root.logic.tryPlaceBuilding({
          origin: new shapez.Vector(cell.x, cell.y),
          building: meta,
          rotation: rotation,
          originalRotation: rotation,
          rotationVariant: rotationVariant,
          variant: "default",
        });
        if (entity) {
          placed += 1;
        } else {
          failed.push({ index: i, x: cell.x, y: cell.y });
        }
      }
    });

    return { requested: cells.length, placed: placed, failed: failed, layer: layer };
  }

  /**
   * 关掉挡住模拟的弹窗：关卡完成弹窗（unlockNotification）会让 hud.shouldPauseGame() 为 true，
   * 此时 miner/传送带全部停摆，但 status 里的 speed 仍是 RegularGameSpeed。自动化前必须先调这个。
   */
  dismissDialogs() {
    var self = this;
    var actions = [];

    function pausedNow() {
      try {
        return !!self.root.hud.shouldPauseGame();
      } catch (error) {
        return null;
      }
    }

    function step(depth) {
      if (depth > 5 || !self.root) {
        return null;
      }
      var hud = self.root.hud;
      var unlock = hud.parts && hud.parts.unlockNotification;
      if (unlock && unlock.visible) {
        actions.push("unlockNotification");
        try {
          unlock.requestClose();
        } catch (error) {
          unlock.close();
        }
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve(step(depth + 1));
          }, 350);
        });
      }
      var dialogs = hud.parts && hud.parts.dialogs;
      if (dialogs && dialogs.dialogStack && dialogs.dialogStack.length > 0) {
        var top = dialogs.dialogStack[dialogs.dialogStack.length - 1];
        actions.push("dialog:" + (top.title || "?"));
        try {
          dialogs.closeDialog(top);
        } catch (error) {
          /* 忽略 */
        }
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve(step(depth + 1));
          }, 220);
        });
      }
      var shop = hud.parts && hud.parts.shop;
      if (shop && shop.visible && shop.hide) {
        shop.hide();
        actions.push("shop");
      }
      return null;
    }

    return Promise.resolve(step(0)).then(function () {
      return { dismissed: actions, pausedByHud: pausedNow() };
    });
  }

  /**
   * dev 构建专用的「直接完成当前目标」——和游戏里按 p 键跳过目标是同一条路径
   * （hub_goals 的 G_IS_DEV 监听器调的就是 onGoalCompleted）。只在 dev 构建里有效。
   */
  devSkipGoal() {
    var root = this.requireRoot();
    var hub = root.hubGoals;
    if (typeof hub.isEndOfDemoReached === "function" && hub.isEndOfDemoReached()) {
      return { skipped: false, reason: "已到当前关卡表的最后一关", level: hub.level };
    }
    var before = hub.level;
    hub.onGoalCompleted();
    return {
      skipped: hub.level !== before,
      level: hub.level,
      levelCount: root.gameMode && root.gameMode.getLevelDefinitions ? root.gameMode.getLevelDefinitions().length : null,
      goalShape: hub.currentGoal && hub.currentGoal.definition ? hub.currentGoal.definition.getHash() : null,
      required: hub.currentGoal ? hub.currentGoal.required : null,
    };
  }

  /** 立即把当前存档写盘（游戏自动存档默认 60 秒一次，跳关后不落盘，重载页面会退回旧关卡）。 */
  saveGame() {
    var root = this.requireRoot();
    try {
      if (root.automaticSave && typeof root.automaticSave.doSave === "function") {
        root.automaticSave.doSave();
      } else if (root.gameState && typeof root.gameState.doSave === "function") {
        root.gameState.doSave();
      } else {
        return { saved: false, reason: "找不到自动存档入口" };
      }
      return { saved: true, level: root.hubGoals ? root.hubGoals.level : null };
    } catch (error) {
      return { saved: false, reason: errorPayload(error).message };
    }
  }

  listBuildings() {
    var variants = shapez.gBuildingVariants || {};
    var result = [];
    for (var code in variants) {
      if (!Object.prototype.hasOwnProperty.call(variants, code)) {
        continue;
      }
      var entry = variants[code];
      result.push({
        code: code === "undefined" || code === "null" ? null : isNaN(Number(code)) ? code : Number(code),
        buildingId: entry.metaInstance ? entry.metaInstance.getId() : null,
        variant: entry.variant,
        rotationVariant: entry.rotationVariant,
        width: entry.tileSize ? entry.tileSize.x : null,
        height: entry.tileSize ? entry.tileSize.y : null,
      });
    }
    return { count: result.length, buildings: result };
  }

  // ---------------------------------------------------------------- 写接口

  placeBuilding(params) {
    var root = this.requireRoot();
    var building = null;
    var variant = typeof params.variant === "string" && params.variant ? params.variant : "default";
    var rotationVariant = params.rotationVariant || 0;

    if (params.code !== undefined && params.code !== null) {
      var info = shapez.gBuildingVariants ? shapez.gBuildingVariants[params.code] : null;
      if (!info) {
        return { ok: false, reason: "未知建筑编号 code: " + String(params.code) + "（先用 shapez_list_buildings 查）" };
      }
      building = info.metaInstance;
      variant = info.variant;
      rotationVariant = info.rotationVariant;
    } else {
      building = shapez.gMetaBuildingRegistry.findById(params.buildingId);
    }

    var rotation = params.rotation || 0;
    if (rotation % 90 !== 0) {
      throw new Error("rotation 必须是 90 的倍数（0=上 90=右 180=下 270=左），收到 " + rotation);
    }
    var entity = root.logic.tryPlaceBuilding({
      origin: new shapez.Vector(params.x, params.y),
      building: building,
      rotation: rotation,
      originalRotation: rotation,
      rotationVariant: rotationVariant,
      variant: variant,
    });
    if (!entity) {
      return { ok: false, reason: "放置失败：位置被占用或地形不允许" };
    }
    return {
      ok: true,
      uid: entity.uid,
      buildingId: params.buildingId || null,
      code: params.code === undefined ? null : params.code,
      variant: variant,
      rotationVariant: rotationVariant,
      rotation: rotation,
    };
  }

  placeBuildings(params) {
    var self = this;
    var root = this.requireRoot();
    var list = params.buildings;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("buildings 必须是非空数组");
    }
    var results = [];
    // 批量放置必须包在 bulkOperation 里，否则每次放置都触发全量缓存重算
    root.logic.performBulkOperation(function () {
      for (var i = 0; i < list.length; i++) {
        try {
          var result = self.placeBuilding(list[i]);
          if (result.ok !== true) {
            results.push({ index: i, reason: result.reason });
          }
        } catch (error) {
          results.push({ index: i, reason: errorPayload(error).message });
        }
      }
    });
    return { requested: list.length, placed: list.length - results.length, failed: results };
  }

  deleteBuilding(params) {
    var root = this.requireRoot();
    var layer = params.layer || root.currentLayer;
    var entity = root.map.getLayerContentXY(params.x, params.y, layer);
    if (!entity) {
      return { ok: false, reason: "该位置（层 " + layer + "）没有建筑" };
    }
    if (!entity.uid) {
      return { ok: false, reason: "该位置的内容不是可删除的建筑" };
    }
    var info = this.describeEntity(entity);
    root.logic.tryDeleteBuilding(entity);
    return { ok: true, uid: entity.uid, buildingId: info ? info.buildingId : null, layer: layer };
  }

  setSpeed(params) {
    var root = this.requireRoot();
    var mode = params.mode;
    var next;
    if (mode === "paused") {
      next = new shapez.PausedGameSpeed(root);
    } else if (mode === "fast_forward") {
      next = new shapez.FastForwardGameSpeed(root);
    } else if (mode === "regular") {
      next = new shapez.RegularGameSpeed(root);
    } else {
      throw new Error("未知速度模式: " + String(mode));
    }
    root.time.speed = next;
    return {
      mode: mode,
      speed: root.time.speed && root.time.speed.constructor ? root.time.speed.constructor.name : null,
      multiplier: root.time.speed && root.time.speed.getTimeMultiplier ? root.time.speed.getTimeMultiplier() : null,
      note: "速度不写入存档，重载存档后回到正常速度",
    };
  }

  waitTicks(params) {
    var root = this.requireRoot();
    var ticks = params.ticks || 60;
    var multiplier = 1;
    try {
      multiplier = root.time.speed.getTimeMultiplier();
    } catch (error) {
      multiplier = 1;
    }
    if (!(multiplier > 0)) {
      // 暂停状态下等待没有意义，直接返回，避免把 MCP 调用挂死
      return { ticks: ticks, waitedMs: 0, multiplier: multiplier, note: "游戏处于暂停状态，未等待" };
    }
    var ms = Math.min(60000, Math.round((ticks * (1000 / 60)) / multiplier));
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve({ ticks: ticks, waitedMs: ms, multiplier: multiplier, approximate: true });
      }, ms);
    });
  }

  // ------------------------------------------------------------------ 工具

  requireRoot() {
    if (!this.root) {
      var error = new Error("游戏还没有加载存档：请先在游戏里进入一局游戏");
      error.code = "no_save";
      throw error;
    }
    return this.root;
  }

  collectEntities() {
    var root = this.root;
    if (!root || !root.entityMgr || !root.entityMgr.entities) {
      return [];
    }
    var source = root.entityMgr.entities;
    var list = [];
    if (typeof source.forEach === "function") {
      source.forEach(function (entity) {
        list.push(entity);
      });
      return list;
    }
    if (Array.isArray(source)) {
      return source;
    }
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        list.push(source[key]);
      }
    }
    return list;
  }

  describeEntity(entity) {
    if (!entity || !entity.components || !entity.components.StaticMapEntity) {
      return null;
    }
    var staticComp = entity.components.StaticMapEntity;
    var info = {
      uid: entity.uid,
      x: staticComp.origin ? staticComp.origin.x : null,
      y: staticComp.origin ? staticComp.origin.y : null,
      rotation: staticComp.rotation,
      layer: staticComp.layer,
      buildingId: null,
      width: 1,
      height: 1,
    };
    try {
      info.buildingId = staticComp.getMetaBuilding().getId();
    } catch (error) {
      info.buildingId = null;
    }
    try {
      var bounds = staticComp.getTileSpaceBounds ? staticComp.getTileSpaceBounds() : null;
      if (bounds) {
        info.width = bounds.w;
        info.height = bounds.h;
      }
    } catch (error) {
      // 保持默认 1x1
    }
    return info;
  }

  methods = {
    status: this.status,
    listBuildings: this.listBuildings,
    buildBeltPath: this.buildBeltPath,
    dismissDialogs: this.dismissDialogs,
    devSkipGoal: this.devSkipGoal,
    saveGame: this.saveGame,
    queryResources: this.queryResources,
    inspectTile: this.inspectTile,
    queryEntities: this.queryEntities,
    hubGoals: this.hubGoals,
    productionRates: this.productionRates,
    decodeShape: this.decodeShape,
    evalCode: this.evalCode,
    placeBuilding: this.placeBuilding,
    placeBuildings: this.placeBuildings,
    deleteBuilding: this.deleteBuilding,
    setSpeed: this.setSpeed,
    waitTicks: this.waitTicks,
  };
}

function intersects(info, bounds) {
  var x1 = info.x;
  var y1 = info.y;
  var x2 = info.x + (info.width || 1) - 1;
  var y2 = info.y + (info.height || 1) - 1;
  return !(x2 < bounds.x1 || x1 > bounds.x2 || y2 < bounds.y1 || y1 > bounds.y2);
}

/** 把游戏内部对象转成 JSON 可序列化的普通结构（Map → 对象，函数丢弃，深度限 3 层）。 */
function toPlain(value, depth) {
  var level = depth === undefined ? 0 : depth;
  if (value === null || value === undefined) {
    return null;
  }
  var type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    return value;
  }
  if (type === "function") {
    return undefined;
  }
  if (level >= 3) {
    return String(value);
  }
  if (Array.isArray(value)) {
    var array = [];
    for (var i = 0; i < value.length; i++) {
      array.push(toPlain(value[i], level + 1));
    }
    return array;
  }
  if (typeof value.forEach === "function" && typeof value.get === "function") {
    var fromMap = {};
    value.forEach(function (item, key) {
      fromMap[String(key)] = toPlain(item, level + 1);
    });
    return fromMap;
  }
  var object = {};
  for (var key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    var converted = toPlain(value[key], level + 1);
    if (converted !== undefined) {
      object[key] = converted;
    }
  }
  return object;
}
