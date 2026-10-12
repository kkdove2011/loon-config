/* NodeSeek for Loon — optimized 2026-10-12 by kkdove2011.
 * Based on kqdmaomao/loon-personal (plugins branch); see SOURCES.md.
 * Cookie stays in Loon persistent storage and is sent only to www.nodeseek.com.
 * No raw headers, errors, or response bodies are logged or shown in notifications.
 * HTTP capture always uses $done({}) to leave the original request unchanged.
 * Requires Loon Build 662+; use the current App Store release where possible.
 */
(function () {
  "use strict";
  var STATE_KEY = "nodeseek.loon.v2.state";
  var LOCK_KEY = "nodeseek.loon.v2.lock";
  var isHTTP = typeof $request !== "undefined" && $request !== null;
  var ended = false;
  var timer = null;
  var lockId = null;

  function read(key) {
    var value = $persistentStore.read(key);
    if (!value) return null;
    try {
      var parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (_) { return null; }
  }
  function save(value, key) {
    return $persistentStore.write(JSON.stringify(value), key) === true;
  }
  function finish() {
    if (ended) return;
    ended = true;
    // Loon does not guarantee clearTimeout; cleanup must still reach $done.
    if (timer !== null && typeof clearTimeout === "function") {
      try { clearTimeout(timer); } catch (_) {}
    }
    if (lockId !== null) {
      try {
        var lock = read(LOCK_KEY);
        if (lock && lock.id === lockId) $persistentStore.write(null, LOCK_KEY);
      } catch (_) { /* The short-lived lock expires even if removal fails. */ }
    }
    if (isHTTP) $done({}); else $done();
  }
  function report(title, detail, quiet) {
    // Both strings come from fixed local text; never from a server/error object.
    try { console.log("[NodeSeek] " + title + "：" + detail); } catch (_) {}
    if (!quiet) {
      try { $notification.post("NodeSeek", title, detail, {openUrl: "https://www.nodeseek.com/board"}); } catch (_) {}
    }
  }
  function header(headers, name) {
    var keys = Object.keys(headers || {});
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === name.toLowerCase()) return headers[keys[i]];
    }
    return "";
  }
  function argumentsMap() {
    var args = Object.create(null);
    if (typeof $argument !== "undefined" && $argument && typeof $argument === "object") {
      Object.keys($argument).forEach(function (key) { args[key] = String($argument[key]); });
      return args;
    }
    var value = typeof $argument === "string" ? $argument : "";
    value.split("&").forEach(function (part) {
      var pos = part.indexOf("=");
      if (pos >= 0) {
        try { args[decodeURIComponent(part.slice(0, pos))] = decodeURIComponent(part.slice(pos + 1)); } catch (_) {}
      }
    });
    return args;
  }
  function chinaDay() {
    return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  function capture() {
    // Capture only browser visits to home, board or search; never the API or logout.
    if (!/^https:\/\/www\.nodeseek\.com\/(?:\?.*|(?:board|search)(?:[/?].*)?)?$/i.test(String($request.url || ""))) return;
    var cookie = header($request.headers, "cookie");
    var ua = header($request.headers, "user-agent");
    if (typeof cookie !== "string" || !cookie.trim() || /[\r\n]/.test(cookie)) return;
    cookie = cookie.trim();
    if (typeof ua !== "string" || /[\r\n]/.test(ua)) ua = "";
    var old = read(STATE_KEY);
    var changed = !old || old.cookie !== cookie;
    var now = Date.now();
    var previousNotice = Number(old && old.lastCaptureNotice) || 0;
    var notify = changed && (!previousNotice || now - previousNotice >= 300000 || now < previousNotice);
    var next = {
      cookie: cookie,
      userAgent: ua || (old && old.userAgent) || "",
      lastDay: changed ? "" : old.lastDay || "",
      lastCaptureNotice: notify ? now : previousNotice
    };
    if (old && old.cookie === next.cookie && old.userAgent === next.userAgent) return;
    if (!save(next, STATE_KEY)) {
      report("凭证保存失败", "请检查 Loon 本地存储后重新访问首页。");
    } else if (notify) {
      report("已保存浏览器凭证", "保存在 Loon 本机；请运行手动签到验证登录状态。");
    }
  }
  function completeDay(cookie, day) {
    var latest = read(STATE_KEY);
    // A browser capture may have changed accounts while the HTTP request ran.
    if (!latest || latest.cookie !== cookie) return false;
    latest.lastDay = day;
    return save(latest, STATE_KEY);
  }
  function checkin(args) {
    var state = read(STATE_KEY);
    if (!state || typeof state.cookie !== "string" || !state.cookie.trim() || /[\r\n]/.test(state.cookie)) {
      report("缺少登录凭证", "请开启 NodeSeek Cookie 获取脚本，用 Safari 登录并访问首页。");
      finish(); return;
    }
    var day = chinaDay();
    if (state.lastDay === day && args.force !== "true") {
      report("今天已记录完成", "已跳过请求；可运行强制核验在服务器重新确认。", args.quiet === "true");
      finish(); return;
    }
    var lock = read(LOCK_KEY);
    if (lock && Number(lock.until) > Date.now() && Number(lock.until) <= Date.now() + 90000) {
      report("签到正在执行", "请稍后查看结果，避免同时手动运行和定时运行。", args.quiet === "true");
      finish(); return;
    }
    lockId = String(Date.now()) + "-" + String(Math.random());
    if (!save({id: lockId, until: Date.now() + 60000}, LOCK_KEY)) {
      report("本地存储不可用", "未发起签到请求；请检查 Loon 后重试。");
      finish(); return;
    }
    var headers = {
      "Cookie": state.cookie,
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Origin": "https://www.nodeseek.com",
      "Referer": "https://www.nodeseek.com/board"
    };
    if (typeof state.userAgent === "string" && state.userAgent && !/[\r\n]/.test(state.userAgent)) headers["User-Agent"] = state.userAgent;
    timer = setTimeout(function () {
      if (ended) return;
      report("请求超时", "未记录成功；请检查网络后再手动运行。");
      finish();
    }, 25000);
    $httpClient.post({
      url: "https://www.nodeseek.com/api/attendance?random=" + (args.random === "false" ? "false" : "true"),
      headers: headers,
      body: "{}",
      timeout: 20000,
      "auto-redirect": false,
      "auto-cookie": false,
      insecure: false
      // No node override: use the user's existing routing rule.
    }, function (error, response, body) {
      if (ended) return;
      try {
        if (error) {
          report("网络请求失败", "未记录成功；请检查 NodeSeek 分流策略和网络。");
          return;
        }
        var status = Number(response && response.status);
        if (status === 401) {
          report("登录状态失效", "请在 Safari 重新登录并访问首页以更新凭证。"); return;
        }
        if (status === 403) {
          report("访问被拒绝（403）", "可能需要浏览器验证或更新凭证；请在 Safari 打开论坛处理。"); return;
        }
        if (status >= 300 && status < 400) {
          report("收到重定向", "已停止跟随，避免向其他地址发送凭证；请用 Safari 检查登录。"); return;
        }
        if (status === 429) {
          report("请求过于频繁（429）", "请稍后再试，未进行自动重试。"); return;
        }
        if (!(status >= 200 && status < 300)) {
          report("服务器请求失败", "未记录签到成功，请稍后查看论坛或重试。"); return;
        }
        var result;
        try { result = JSON.parse(body); } catch (_) {
          report("响应不是有效 JSON", "可能是验证页面；请用 Safari 打开论坛检查。"); return;
        }
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          report("响应格式不匹配", "未记录成功，请在论坛核对签到结果。"); return;
        }
        // Only explicit success or a narrow affirmative already-done message counts.
        var already = typeof result.message === "string" &&
          /^(?:今天|今日)(?:已经|已)(?:完成)?签到[。！!\s]*$/.test(result.message.trim());
        if (result.success === true || already) {
          var recorded = completeDay(state.cookie, day);
          report(already ? "论坛提示今天已签到" : "签到成功", recorded ?
            "已记录今天完成；可在论坛签到页查看奖励。" :
            "服务器已确认；本地记录未保存或凭证已改变，请在论坛核对。");
        } else {
          report("签到未获确认", "接口未返回明确成功或今日已签到，未记录完成；请在论坛核对。");
        }
      } catch (_) {
        report("处理结果失败", "未记录确认结果，请在论坛核对签到状态。");
      } finally { finish(); }
    });
  }
  try {
    // $loon is a device/version string. Only iPhone is authorized to execute.
    // Unknown devices, iPad and Mac fail closed, including capture and clear.
    if (typeof $loon !== "string" || !/^iPhone(?:\d|[\s,]|$)/i.test($loon.trim())) {
      try { console.log("[NodeSeek] 已跳过：仅允许 iPhone 执行。"); } catch (_) {}
      finish(); return;
    }
    if (isHTTP) {
      try { capture(); } finally { finish(); }
    } else {
      var args = argumentsMap();
      if (args.action === "clear") {
        var cleared = $persistentStore.write(null, STATE_KEY) === true;
        report(cleared ? "已清除 NodeSeek 本地凭证" : "清除失败", cleared ?
          "同时清除了每日完成记录；其他脚本的数据未清除。" : "请检查 Loon 本地存储。");
        finish();
      } else { checkin(args); }
    }
  } catch (_) {
    report("脚本执行失败", "请检查脚本安装与 Loon 版本；日志不输出敏感信息。");
    finish();
  }
})();
