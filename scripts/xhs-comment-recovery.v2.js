/* Loon response script v2. No network requests or credential storage. */
(function () {
  var result = {};
  function report(message) {
    console.log('[小红书评论恢复 v2] ' + message);
    try {
      var key = 'xhs.comment.recovery.v2.notice';
      var now = Date.now();
      var last = Number($persistentStore.read(key) || 0);
      if (now - last >= 60000) {
        $notification.post('小红书封禁评论恢复 v2', '', message);
        $persistentStore.write(String(now), key);
      }
    } catch (_) { /* Diagnostics must not prevent response processing. */ }
  }
  try {
    if (!/^https:\/\/edith\.xiaohongshu\.com\/api\/sns\/v3\/user\/me(?:\?|$)/.test($request.url)) {
      return $done({});
    }
    var payload = JSON.parse($response.body);
    var data = payload && payload.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.userid ||
        (payload.code !== undefined && payload.code !== 0) || payload.success === false) {
      report('已命中主页请求，但响应没有有效账号数据；未修改。');
      return $done({});
    }
    if (data.is_recommend_level_illegal !== true &&
        !(data.illegal_info && Number(data.illegal_info.forbidden_reason) === 1)) {
      report('已命中主页请求，未检测到封禁标记；未修改。');
      return $done({});
    }
    var tabs = data.hula_tabs && data.hula_tabs.all_show_tab_config;
    var comment = Array.isArray(tabs) && tabs.filter(function (tab) {
      return tab && tab.tab_id === 'comment';
    })[0];
    if (!comment) {
      report('已命中主页请求，但服务端未提供评论标签；未修改。');
      return $done({});
    }
    data.is_recommend_level_illegal = false;
    delete data.illegal_info;
    data.hula_tabs.tab_id_selected = 'comment';
    // Keep the existing comment tab and its privacy lock; put it before notes.
    comment.tab_index_weight = -1;
    data.hula_tabs.all_show_tab_config = [comment].concat(tabs.filter(function (tab) {
      return tab !== comment;
    }));
    result = { body: JSON.stringify(payload) };
    report('已命中并修改主页响应，默认选中评论。若仍不显示，请导出本次 HAR 继续排查。');
  } catch (_) {
    report('已命中但无法处理主页 JSON；保留原响应，请导出本次 HAR。');
  }
  $done(result);
}());
