/**
 * Otto Local Agent Discovery SDK — otto-discovery.js
 *
 * 嵌入企业服务器网页，自动探测用户本地是否运行着 otto。
 * 安全设计：
 *   - 只探测只读 /health 和 /local-agent/ping 接口
 *   - 不发起任何写操作
 *   - 探测间隔受控，不会对本地服务造成压力
 *
 * 用法：
 *   <script src="otto-discovery.js"></script>
 *   <script>
 *     OttoDiscovery.detect(function(result) {
 *       if (result.found) {
 *         console.log('发现本地 Otto:', result.instanceId);
 *         // 显示接入按钮
 *       }
 *     });
 *   </script>
 *
 * @license Apache-2.0
 */
(function (global) {
  'use strict';

  /** 默认本地 otto 端口（与 DEFAULT_PORT 保持一致） */
  var DEFAULT_PORT = 7637;

  /** 探测超时（毫秒）：本地服务应该在 200ms 内响应 */
  var DETECT_TIMEOUT_MS = 500;

  /** 缓存上一次探测结果，避免频繁重试 */
  var _lastResult = null;
  var _lastCheckTime = 0;
  var CACHE_TTL_MS = 30000; // 30 秒缓存

  /**
   * @typedef {Object} OttoDetectionResult
   * @property {boolean} found - 是否检测到本地 otto
   * @property {string|null} instanceId - 本地 otto 实例标识（仅 found=true 时有效）
   * @property {string|null} version - otto 版本号
   * @property {number} latencyMs - 探测延迟（毫秒）
   * @property {string|null} error - 错误信息（found=false 时可能非空）
   */

  /**
   * 尝试探测本地 otto 在指定端口上。
   * @param {Object} options
   * @param {number} [options.port] - 本地端口，默认 7637
   * @param {number} [options.timeout] - 超时时间（ms），默认 500
   * @returns {Promise<OttoDetectionResult>}
   */
  function probe(options) {
    var port = (options && options.port) || DEFAULT_PORT;
    var timeout = (options && options.timeout) || DETECT_TIMEOUT_MS;
    var pingUrl = 'http://localhost:' + port + '/local-agent/ping';

    var startTime = Date.now();

    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) {
          done = true;
          resolve({
            found: false,
            instanceId: null,
            version: null,
            latencyMs: Date.now() - startTime,
            error: 'timeout after ' + timeout + 'ms',
          });
        }
      }, timeout);

      fetch(pingUrl, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-cache',
      })
        .then(function (res) {
          if (!done && res.ok) return res.json();
          throw new Error('status ' + res.status);
        })
        .then(function (data) {
          if (!done) {
            done = true;
            clearTimeout(timer);
            if (data && data.ok && data.data && data.data.status === 'ok') {
              _lastResult = {
                found: true,
                instanceId: data.data.instanceId || null,
                version: data.data.serverVersion || null,
                latencyMs: Date.now() - startTime,
                error: null,
              };
              _lastCheckTime = Date.now();
              resolve(_lastResult);
            } else {
              resolve({
                found: false,
                instanceId: null,
                version: null,
                latencyMs: Date.now() - startTime,
                error: 'unexpected response format',
              });
            }
          }
        })
        .catch(function (err) {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve({
              found: false,
              instanceId: null,
              version: null,
              latencyMs: Date.now() - startTime,
              error: err.message || String(err),
            });
          }
        });
    });
  }

  /**
   * 探测本地 otto。
   *
   * 30 秒内有缓存结果则直接返回缓存，避免频繁探测。
   * 传入 force=true 跳过缓存。
   *
   * @param {function(OttoDetectionResult): void} callback
   * @param {Object} [options]
   * @param {boolean} [options.force] - 强制探测，忽略缓存
   * @param {number} [options.port] - 端口号
   * @returns {Promise<OttoDetectionResult>}
   */
  function detect(callback, options) {
    var force = !!(options && options.force);

    if (!force && _lastResult && (Date.now() - _lastCheckTime) < CACHE_TTL_MS) {
      if (typeof callback === 'function') {
        setTimeout(function () { callback(_lastResult); }, 0);
      }
      return Promise.resolve(_lastResult);
    }

    return probe(options).then(function (result) {
      if (typeof callback === 'function') {
        callback(result);
      }
      return result;
    });
  }

  /**
   * 持续探测直到找到本地 otto 或超时。
   * 适用场景：页面加载后等待 otto 启动完成。
   *
   * @param {function(OttoDetectionResult): void} callback - 找到后回调
   * @param {Object} [options]
   * @param {number} [options.maxWaitMs] - 最长等待时间（ms），默认 30000
   * @param {number} [options.intervalMs] - 重试间隔（ms），默认 2000
   */
  function waitForDetection(callback, options) {
    var maxWaitMs = (options && options.maxWaitMs) || 30000;
    var intervalMs = (options && options.intervalMs) || 2000;
    var startTime = Date.now();

    function tryDetect() {
      detect(function (result) {
        if (result.found) {
          callback(result);
        } else if (Date.now() - startTime < maxWaitMs) {
          setTimeout(tryDetect, intervalMs);
        } else {
          callback(result); // timeout — result.found === false
        }
      }, { force: true });
    }

    tryDetect();
  }

  // ── Public API ──
  var OttoDiscovery = {
    detect: detect,
    probe: probe,
    waitForDetection: waitForDetection,
    DEFAULT_PORT: DEFAULT_PORT,
    VERSION: '0.1.0',
  };

  global.OttoDiscovery = OttoDiscovery;
})(typeof window !== 'undefined' ? window : this);
