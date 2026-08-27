/**
 * @license
 * Copyright 2026 Felix
 * https://github.com/NSIETeam/otto-new
 * SPDX-License-Identifier: Apache-2.0
 */


import * as fs from 'fs';
import * as path from 'path';

/**
 * NOTE: We intentionally do NOT use import.meta.url or fileURLToPath here.
 *
 * The issue: When webpack bundles code, it converts import.meta.url to a static
 * string containing the build-time absolute path. This causes cross-platform failures:
 * - Built on Linux: path becomes "file:///mnt/d/..." or "file:///app/..."
 * - Run on Windows: fileURLToPath() fails with "[UriError]: Scheme contains illegal characters"
 *
 * Solution: For VSCode extension (webpack bundled), we rely entirely on:
 * 1. customBasePath set via AuthTemplates.setBasePath(extensionPath)
 * 2. process.cwd() as fallback
 *
 * For CLI (esbuild bundled), import.meta.url works because esbuild's banner
 * computes it at runtime, not build-time.
 */

// This will be empty in webpack-bundled environments, which is intentional.
// The AuthTemplates class uses customBasePath (set from extension.ts) instead.
// We use a function to avoid TypeScript narrowing the type to literal ''
function getCurrentDirname(): string {
  // In CLI (esbuild), __dirname is available via the banner
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (globalThis as any).__dirname === 'string') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).__dirname;
  }
  // In webpack bundle or other environments, return empty
  return '';
}
const currentDirname = getCurrentDirname();

/**
 * HTML模板管理类
 */
export class AuthTemplates {
  private static cache = new Map<string, string>();
  private static customBasePath: string | null = null;

  /**
   * 设置自定义基础路径（用于VSCode扩展等打包环境）
   * @param basePath 扩展的根目录路径
   */
  static setBasePath(basePath: string): void {
    this.customBasePath = basePath;
    console.log(`📁 [AuthTemplates] Custom base path set: ${basePath}`);
  }

  /**
   * 获取认证选择页面模板
   */
  static getAuthSelectPage(): string {
    return this.loadTemplate('authSelectPage.html');
  }

  /**
   * 获取飞书成功页面模板
   */
  static getFeishuSuccessPage(): string {
    return this.generateFeishuSuccessTemplate();
  }

  /**
   * 获取Otto成功页面模板
   */
  static getOttoSuccessPage(): string {
    return this.generateOttoSuccessTemplate();
  }

  /**
   * 获取错误页面模板
   */
  static getErrorPage(message: string): string {
    return this.generateErrorTemplate(message);
  }

  /**
   * 加载模板文件
   * 支持开发环境和VSCode扩展打包后的生产环境
   */
  private static loadTemplate(filename: string): string {
    // 使用缓存提高性能
    if (this.cache.has(filename)) {
      return this.cache.get(filename)!;
    }

    try {
      // 构建可能的模板路径列表（按优先级排序）
      const possiblePaths: string[] = [];

      // 0. 如果设置了自定义基础路径，优先使用（VSCode扩展环境）
      if (this.customBasePath) {
        possiblePaths.push(path.join(this.customBasePath, 'dist', 'bundled', 'auth', 'login', 'templates', filename));
        possiblePaths.push(path.join(this.customBasePath, 'bundled', 'auth', 'login', 'templates', filename));
        possiblePaths.push(path.join(this.customBasePath, 'auth', 'login', 'templates', filename));
      }

      // 1. 当前目录（开发环境 - 源码中的templates目录）
      // Only add if currentDirname is valid (non-empty and not a cross-platform mismatch)
      if (currentDirname) {
        possiblePaths.push(path.join(currentDirname, filename));
      }

      // 2. VSCode扩展打包后的路径结构
      // 在VSCode扩展中，core被打包到 dist/bundled/，模板被复制到 dist/bundled/auth/login/templates/
      // 需要从可能被打包的currentDirname推导出实际的文件位置

      // 尝试从currentDirname向上查找，构建多种可能的路径
      // Only do this if currentDirname is valid (not empty from cross-platform mismatch)
      if (currentDirname) {
        let currentDir = currentDirname;
        for (let i = 0; i < 10; i++) {
          // VSCode扩展的标准路径: dist/bundled/auth/login/templates/
          possiblePaths.push(path.join(currentDir, 'bundled', 'auth', 'login', 'templates', filename));
          // 备用路径1: bundled/（直接在bundled目录下）
          possiblePaths.push(path.join(currentDir, 'bundled', filename));
          // 备用路径2: bundle/login/templates/（CLI打包后的路径 - npm run dev和打包后都会用）
          possiblePaths.push(path.join(currentDir, 'bundle', 'login', 'templates', filename));
          // 备用路径3: auth/login/templates/（相对路径）
          possiblePaths.push(path.join(currentDir, 'auth', 'login', 'templates', filename));

          currentDir = path.dirname(currentDir);
        }
      }

      // 3. 使用process.cwd()作为基准（CLI环境或Node进程根目录）
      if (typeof process !== 'undefined' && process.cwd) {
        try {
          const cwd = process.cwd();
          // CLI开发环境优先路径: {project_root}/bundle/login/templates/
          possiblePaths.push(path.join(cwd, 'bundle', 'login', 'templates', filename));
          // VSCode扩展路径
          possiblePaths.push(path.join(cwd, 'dist', 'bundled', 'auth', 'login', 'templates', filename));
          possiblePaths.push(path.join(cwd, 'bundled', 'auth', 'login', 'templates', filename));
          possiblePaths.push(path.join(cwd, 'auth', 'login', 'templates', filename));
      } catch {
          // process.cwd() 可能在某些环境下失败，忽略
        }
      }

      // 查找第一个存在的模板文件
      let foundPath: string | null = null;
      for (const testPath of possiblePaths) {
        try {
          if (fs.existsSync(testPath)) {
            foundPath = testPath;
            console.error(`✅ [AuthTemplates] Template loaded: ${filename} from ${testPath}`);
            break;
          }
      } catch {
          // 某些路径可能因权限问题无法访问，继续尝试下一个
          continue;
        }
      }

      if (!foundPath) {
        // 记录所有尝试过的路径，帮助调试
        console.warn(`⚠️ [AuthTemplates] Template ${filename} not found in any location.`);
        console.warn(`   Tried ${possiblePaths.length} paths. First 5:`);
        possiblePaths.slice(0, 5).forEach((p, i) => console.warn(`   ${i + 1}. ${p}`));
        console.warn(`   Current dirname: ${currentDirname || '(unavailable - cross-platform build)'}`);
        console.warn(`   Custom base path: ${this.customBasePath || '(not set)'}`);
        if (typeof process !== 'undefined' && process.cwd) {
          try {
            console.warn(`   Process cwd: ${process.cwd()}`);
      } catch {
            console.warn(`   Process cwd: unavailable`);
          }
        }

        // 使用fallback模板
        console.log(`ℹ️ [AuthTemplates] Using fallback template for ${filename}`);
        return this.generateBasicAuthSelectTemplate();
      }

      const template = fs.readFileSync(foundPath, 'utf-8');
      this.cache.set(filename, template);
      return template;
    } catch (error) {
      console.error(`❌ [AuthTemplates] Failed to load template ${filename}:`, error);
      // 如果无法加载模板文件，返回一个基本的HTML
      return this.generateBasicAuthSelectTemplate();
    }
  }

  /**
   * 生成基本的认证选择模板（作为fallback）
   */
  private static generateBasicAuthSelectTemplate(): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title data-i18n="auth.page.title">Choose Authentication Method</title>
        <meta charset="utf-8">
        <style>
          body {
            font-family: 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            text-align: center;
            padding: 50px;
            background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
            color: #1e293b;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .container {
            max-width: 420px;
            margin: 0 auto;
            background: white;
            padding: 40px;
            border-radius: 16px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
            border: 1px solid #f1f5f9;
          }
          .title {
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 12px;
            color: #0f172a;
          }
          .subtitle {
            color: #64748b;
            margin-bottom: 32px;
            font-size: 16px;
          }
          .auth-button {
            display: flex;
            align-items: center;
            justify-content: flex-start;
            width: 100%;
            padding: 16px;
            margin: 16px 0;
            background: #ffffff;
            color: #374151;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            cursor: pointer;
            font-size: 16px;
            font-weight: 600;
            font-family: inherit;
            transition: all 0.15s ease;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
          }
          .auth-button:hover {
            background: #f9fafb;
            border-color: #1e293b;
            color: #1e293b;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(30, 41, 59, 0.15);
          }
          .feishu-btn:hover {
            border-color: #0ea5e9;
            color: #0ea5e9;
            box-shadow: 0 4px 12px rgba(14, 165, 233, 0.15);
          }
          .hidden { display: none !important; }
          .loading-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 40px 20px;
          }
          .loading-spinner {
            width: 32px;
            height: 32px;
            border: 3px solid #e2e8f0;
            border-top: 3px solid #3b82f6;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 12px;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          .loading-text {
            color: #64748b;
            font-size: 14px;
          }
          .china-message {
            background: #fef2f2;
            border: 2px solid #fecaca;
            border-radius: 12px;
            padding: 24px;
            margin: 20px 0;
            text-align: center;
          }
          .china-message-icon {
            font-size: 32px;
            margin-bottom: 12px;
          }
          .china-message-title {
            font-size: 18px;
            font-weight: 600;
            color: #dc2626;
            margin-bottom: 12px;
          }
          .china-message-content {
            color: #7f1d1d;
            font-size: 14px;
            line-height: 1.6;
            margin-bottom: 8px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1 class="title" data-i18n="auth.page.title">Choose Authentication</h1>
          <p class="subtitle" data-i18n="auth.page.description">Select your preferred login method to continue</p>

          <!-- 加载中效果 -->
          <div id="loading-container" class="loading-container">
            <div class="loading-spinner"></div>
            <div class="loading-text" data-i18n="auth.loading.text">Checking access permissions...</div>
          </div>

          <!-- 登录按钮容器 -->
          <div id="auth-buttons-container" class="hidden">
            <!-- 飞书登录按钮区域（动态生成，支持多租户） -->
            <div id="feishu-buttons-container"></div>

            <button class="auth-button" onclick="startOttoAuth()" data-i18n="auth.otto.button">
              <span style="font-size: 18px; margin-right: 8px; vertical-align: middle;">🔐</span>
              Otto Login
            </button>
          </div>
        </div>

        <script>
          // 基本的国际化支持
          const translations = {
            en: {
              'auth.page.title': 'Choose Authentication',
              'auth.page.description': 'Select your preferred login method to continue',
              'auth.loading.text': 'Checking access permissions...',
              'auth.feishu.button': 'Feishu Login',
              'auth.otto.button': 'Otto Login',
              'auth.china.restriction.title': 'Access Restricted',
              'auth.feishu.start.error': 'Failed to start Feishu authentication',
              'auth.otto.start.error': 'Failed to start Otto authentication'
            },
            zh: {
              'auth.page.title': '选择认证方式',
              'auth.page.description': '选择您偏好的登录方式以继续',
              'auth.loading.text': '正在检查访问权限...',
              'auth.feishu.button': '飞书登录',
              'auth.otto.button': 'Otto 登录',
              'auth.china.restriction.title': '访问受限',
              'auth.feishu.start.error': '飞书认证启动失败',
              'auth.otto.start.error': 'Otto 认证启动失败'
            }
          };

          function getBrowserLanguage() {
            const lang = navigator.language || navigator.userLanguage;
            return lang.startsWith('zh') ? 'zh' : 'en';
          }

          function t(key) {
            const locale = getBrowserLanguage();
            return translations[locale][key] || translations.en[key] || key;
          }

          function initI18n() {
            document.querySelectorAll('[data-i18n]').forEach(element => {
              const key = element.getAttribute('data-i18n');
              element.textContent = t(key);
              if (element.tagName === 'TITLE') {
                document.title = t(key);
              }
            });
          }

          function checkFeishuAllowed() {
            console.log('🔍 开始检查飞书登录权限...');
            console.log('📡 调用API: /api/backend/feishu-allowed');

            fetch('/api/backend/feishu-allowed')
              .then(response => {
                console.log('🌐 接口响应状态:', response.status);
                console.log('✅ 进入第一个then块');
                return response.json();
              })
              .then(data => {
                console.log('✅ 进入第二个then块 - 开始处理数据');
                console.log('📋 后台接口返回完整数据:', JSON.stringify(data, null, 2));

                // 隐藏加载中效果
                console.log('🔄 开始隐藏loading效果...');
                const loadingContainer = document.getElementById('loading-container');
                console.log('🔍 loading容器元素:', loadingContainer);
                if (loadingContainer) {
                  console.log('⏳ loading容器存在，添加hidden类');
                  loadingContainer.classList.add('hidden');
                  // 双重保险：直接设置display样式
                  loadingContainer.style.display = 'none';
                  console.log('✅ loading hidden类已添加，display设置为none');
                  console.log('🎨 loading容器当前className:', loadingContainer.className);
                  console.log('🎨 loading容器当前style.display:', loadingContainer.style.display);
                } else {
                  console.error('❌ 未找到loading容器元素!');
                }

                // 检查是否是中国IP且不允许登录
                if (data.isChina && !data.feishuLoginAllowed && data.messages && data.messages.length > 0) {
                  // 显示中国IP限制消息
                  const container = document.querySelector('.container');
                  if (container) {
                    const messageDiv = document.createElement('div');
                    messageDiv.style.cssText = 'background: #fef2f2; border: 2px solid #fecaca; border-radius: 12px; padding: 24px; margin: 20px 0; text-align: center; color: #7f1d1d;';
                    messageDiv.innerHTML = data.messages.map(msg => '<p style="margin: 8px 0;">' + msg + '</p>').join('');
                    container.appendChild(messageDiv);
                  }
                } else {
                  // 非中国IP，显示登录选项
                  console.log('✅ 非中国IP，显示登录选项');

                  // 显示登录按钮容器
                  const authButtonsContainer = document.getElementById('auth-buttons-container');
                  if (authButtonsContainer) {
                    authButtonsContainer.classList.remove('hidden');
                  }

                  // Otto登录始终可用（没有hidden类）
                  console.log('✅ Otto登录始终可用');

                  // 根据权限显示飞书登录按钮（动态获取租户列表）
                  if (data.feishuLoginAllowed) {
                    loadFeishuTenants();
                  } else {
                    console.log('🚫 飞书登录被禁用，保持飞书按钮隐藏');
                  }
                }
              })
              .catch(error => {
                console.error('❌ 检查飞书登录权限失败:', error);
                console.log('🔄 进入catch块 - API调用失败');

                // 隐藏加载中效果
                console.log('🔄 catch块中开始隐藏loading效果...');
                const loadingContainer = document.getElementById('loading-container');
                console.log('🔍 catch块中loading容器元素:', loadingContainer);
                if (loadingContainer) {
                  console.log('⏳ catch块中loading容器存在，添加hidden类');
                  loadingContainer.classList.add('hidden');
                  // 双重保险：直接设置display样式
                  loadingContainer.style.display = 'none';
                  console.log('✅ catch块中loading hidden类已添加，display设置为none');
                } else {
                  console.error('❌ catch块中未找到loading容器元素!');
                }

                // 出错时显示登录按钮容器
                const authButtonsContainer = document.getElementById('auth-buttons-container');
                if (authButtonsContainer) {
                  authButtonsContainer.classList.remove('hidden');
                }
              });
          }

          function loadFeishuTenants() {
            fetch('/api/backend/feishu-allowed')
              .then(function() {
                // 租户信息从 /api/config/client 获取（authServer 会代理）
                // 但 CLI 的 authServer 没有这个路由，所以直接用 start-feishu-auth
                // 简化方案：用已有的服务端 API 获取租户列表
                var serverUrl = '';  // 相对路径，走 CLI authServer
                return fetch(serverUrl + '/api/backend/feishu-tenants');
              })
              .then(function(resp) { return resp.json(); })
              .then(function(tenants) {
                renderFeishuButtons(tenants);
              })
              .catch(function() {
                // 获取租户列表失败，显示默认单按钮
                console.log('⚠️ 无法获取租户列表，显示默认飞书按钮');
                renderFeishuButtons([{ appId: '', label: t('auth.feishu.button'), tenantKey: 'main' }]);
              });
          }

          function renderFeishuButtons(tenants) {
            var container = document.getElementById('feishu-buttons-container');
            if (!container) return;
            container.innerHTML = '';
            if (!tenants || tenants.length === 0) {
              tenants = [{ appId: '', label: t('auth.feishu.button'), tenantKey: 'main' }];
            }
            tenants.forEach(function(tenant) {
              var btn = document.createElement('button');
              btn.className = 'auth-button feishu-btn';
              btn.innerHTML = '<span style="font-size:18px;margin-right:8px;vertical-align:middle;">💬</span>' +
                '<span>' + (tenant.label || t('auth.feishu.button')) + '</span>';
              btn.onclick = function() { startFeishuAuth(tenant.appId); };
              container.appendChild(btn);
            });
            console.log('✅ 飞书登录按钮已生成，共 ' + tenants.length + ' 个租户');
          }

          function startFeishuAuth(appId) {
            var body = appId ? JSON.stringify({ appId: appId }) : '{}';
            fetch('/start-feishu-auth', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: body
            })
              .then(response => response.json())
              .then(data => {
                if (data.authUrl) {
                  window.location.replace(data.authUrl);
                }
              })
              .catch(error => alert(t('auth.feishu.start.error')));
          }

          function startOttoAuth() {
            fetch('/start-otto-auth', { method: 'POST' })
              .then(response => response.json())
              .then(data => {
                if (data.authUrl) {
                  window.location.replace(data.authUrl);
                }
              })
              .catch(error => alert(t('auth.otto.start.error')));
          }

          document.addEventListener('DOMContentLoaded', function() {
            initI18n();
            checkFeishuAllowed();
          });
        </script>
      </body>
      </html>
    `;
  }

  /**
   * 生成飞书成功页面模板
   */
  private static generateFeishuSuccessTemplate(): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title data-i18n="auth.feishu.success.title">Feishu Authentication Successful</title>
        <meta charset="utf-8">
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            background: #ffffff;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            color: #1a1a1a;
          }

          .container {
            background: #ffffff;
            border-radius: 12px;
            padding: 48px 32px;
            max-width: 400px;
            width: 100%;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06);
            border: 1px solid #e5e5e5;
            text-align: center;
            animation: fadeIn 0.3s ease;
          }

          .success {
            font-size: 48px;
            margin-bottom: 20px;
            color: #10b981;
            line-height: 1;
          }

          .title {
            font-size: 24px;
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 12px;
            letter-spacing: -0.01em;
          }

          .message {
            color: #6b7280;
            font-size: 16px;
            margin-bottom: 32px;
            line-height: 1.5;
          }

          .instruction {
            color: #374151;
            font-size: 14px;
            font-weight: 500;
            padding: 16px;
            background: #f9fafb;
            border-radius: 8px;
            border: 1px solid #f3f4f6;
            line-height: 1.4;
          }

          @keyframes fadeIn {
            from {
              opacity: 0;
              transform: translateY(10px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }

          @media (max-width: 480px) {
            body {
              padding: 16px;
            }

            .container {
              padding: 32px 24px;
            }

            .success {
              font-size: 40px;
            }

            .title {
              font-size: 20px;
            }

            .message {
              font-size: 14px;
              margin-bottom: 24px;
            }

            .instruction {
              padding: 12px;
              font-size: 13px;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success">✓</div>
          <h1 class="title" data-i18n="auth.feishu.success.title">Feishu Login Successful</h1>
          <p class="message" data-i18n="auth.success.message">You have successfully logged in with Feishu. You can now close this page and return to Otto to continue your work.</p>
          <div class="instruction" data-i18n="auth.success.instruction">Close this page and return to your terminal or IDE to continue using Otto.</div>
        </div>
        ${this.getI18nScript()}
      </body>
      </html>
    `;
  }

  /**
   * 生成Otto成功页面模板
   */
  private static generateOttoSuccessTemplate(): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title data-i18n="auth.otto.success.title">Otto Authentication Successful</title>
        <meta charset="utf-8">
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            background: #ffffff;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            color: #1a1a1a;
          }

          .container {
            background: #ffffff;
            border-radius: 12px;
            padding: 48px 32px;
            max-width: 400px;
            width: 100%;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06);
            border: 1px solid #e5e5e5;
            text-align: center;
            animation: fadeIn 0.3s ease;
          }

          .success {
            font-size: 48px;
            margin-bottom: 20px;
            color: #10b981;
            line-height: 1;
          }

          .title {
            font-size: 24px;
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 12px;
            letter-spacing: -0.01em;
          }

          .message {
            color: #6b7280;
            font-size: 16px;
            margin-bottom: 32px;
            line-height: 1.5;
          }

          .instruction {
            color: #374151;
            font-size: 14px;
            font-weight: 500;
            padding: 16px;
            background: #f9fafb;
            border-radius: 8px;
            border: 1px solid #f3f4f6;
            line-height: 1.4;
          }

          @keyframes fadeIn {
            from {
              opacity: 0;
              transform: translateY(10px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }

          @media (max-width: 480px) {
            body {
              padding: 16px;
            }

            .container {
              padding: 32px 24px;
            }

            .success {
              font-size: 40px;
            }

            .title {
              font-size: 20px;
            }

            .message {
              font-size: 14px;
              margin-bottom: 24px;
            }

            .instruction {
              padding: 12px;
              font-size: 13px;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success">✓</div>
          <h1 class="title" data-i18n="auth.otto.success.title">Otto Login Successful</h1>
          <p class="message" data-i18n="auth.success.message">You have successfully logged in. You can now close this page and return to Otto to continue your work.</p>
          <div class="instruction" data-i18n="auth.success.instruction">Close this page and return to your terminal or IDE to continue using Otto.</div>
        </div>
        ${this.getI18nScript()}
      </body>
      </html>
    `;
  }

  /**
   * 生成错误页面模板
   */
  private static generateErrorTemplate(message: string): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title data-i18n="auth.error.title">Authentication Error</title>
        <meta charset="utf-8">
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            background: #ffffff;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            color: #1a1a1a;
          }

          .container {
            background: #ffffff;
            border-radius: 12px;
            padding: 48px 32px;
            max-width: 400px;
            width: 100%;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06);
            border: 1px solid #e5e5e5;
            text-align: center;
            animation: fadeIn 0.3s ease;
          }

          .error {
            font-size: 48px;
            margin-bottom: 20px;
            color: #ef4444;
            line-height: 1;
          }

          .title {
            font-size: 24px;
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 12px;
            letter-spacing: -0.01em;
          }

          .message {
            color: #6b7280;
            font-size: 16px;
            margin-bottom: 32px;
            line-height: 1.5;
            padding: 16px;
            background: #fef2f2;
            border-radius: 8px;
            border: 1px solid #fecaca;
          }

          .instruction {
            color: #374151;
            font-size: 14px;
            font-weight: 500;
            padding: 16px;
            background: #f9fafb;
            border-radius: 8px;
            border: 1px solid #f3f4f6;
            line-height: 1.4;
          }

          @keyframes fadeIn {
            from {
              opacity: 0;
              transform: translateY(10px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }

          @media (max-width: 480px) {
            body {
              padding: 16px;
            }

            .container {
              padding: 32px 24px;
            }

            .error {
              font-size: 40px;
            }

            .title {
              font-size: 20px;
            }

            .message {
              font-size: 14px;
              margin-bottom: 24px;
              padding: 12px;
            }

            .instruction {
              padding: 12px;
              font-size: 13px;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="error">✕</div>
          <h1 class="title" data-i18n="auth.error.title">Authentication Failed</h1>
          <div class="message">${message}</div>
          <div class="instruction" data-i18n="auth.error.instruction">Please close this page and try again in your terminal or IDE.</div>
        </div>
        ${this.getI18nScript()}
      </body>
      </html>
    `;
  }

  /**
   * 获取国际化脚本
   */
  private static getI18nScript(): string {
    return `
      <script>
        // 国际化翻译对象
        const translations = {
          en: {
            'auth.feishu.success.title': 'Feishu Login Successful',
            'auth.otto.success.title': 'Otto Login Successful',
            'auth.success.message': 'You have successfully logged in. You can now close this page and return to Otto to continue your work.',
            'auth.success.instruction': 'Close this page and return to your terminal or IDE to continue using Otto.',
            'auth.error.title': 'Authentication Failed',
            'auth.error.instruction': '❌ Please close this page and try again in your terminal or IDE.'
          },
          zh: {
            'auth.feishu.success.title': '飞书登录成功',
            'auth.otto.success.title': 'Otto 登录成功',
            'auth.success.message': '您已成功登录。现在可以关闭此页面并返回 Otto 继续您的工作。',
            'auth.success.instruction': '关闭此页面并返回终端或IDE以继续使用 Otto。',
            'auth.error.title': '认证失败',
            'auth.error.instruction': '❌ 请关闭此页面并在终端或IDE中重试。'
          }
        };

        // 获取浏览器语言
        function getBrowserLanguage() {
          const lang = navigator.language || navigator.userLanguage;
          return lang.startsWith('zh') ? 'zh' : 'en';
        }

        // 翻译函数
        function t(key) {
          const locale = getBrowserLanguage();
          return translations[locale][key] || translations.en[key] || key;
        }

        // 初始化页面文本
        function initI18n() {
          document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            const text = t(key);
            element.textContent = text;

            // 同时更新title属性（如果是title标签）
            if (element.tagName === 'TITLE') {
              document.title = text;
            }
          });
        }

        // 页面加载时初始化i18n
        document.addEventListener('DOMContentLoaded', function() {
          initI18n();
        });
      </script>
    `;
  }

  /**
   * 清除缓存
   */
  static clearCache(): void {
    this.cache.clear();
  }
}
