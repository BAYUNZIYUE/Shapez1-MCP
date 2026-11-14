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
  version: "0.1.0",
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

function errorPayload(error) {
  return {
    code: (error && error.code) || "mod_error",
    message: error && error.message ? error.message : String(error),
  };
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
    var result = { level: hub.level, delivered: null, required: null, throughputOnly: null, stored: [], upgrades: {} };

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
    for (var layerIndex = 0; layerIndex < definition.layers.length; layerIndex++) {
      var layer = definition.layers[layerIndex];
      var quadrants = [];
      for (var quadrant = 0; quadrant < 4; quadrant++) {
        var subShape = layer && layer[quadrant];
        quadrants.push(
          subShape
            ? { subShape: String(subShape.subShape), color: String(subShape.color) }
            : null,
        );
      }
      layers.push(quadrants);
    }
    return { valid: true, key: key, hash: definition.getHash(), layers: layers };
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
    queryEntities: this.queryEntities,
    hubGoals: this.hubGoals,
    productionRates: this.productionRates,
    decodeShape: this.decodeShape,
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
