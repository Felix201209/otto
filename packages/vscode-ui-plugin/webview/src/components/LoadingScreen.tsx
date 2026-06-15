/**
 * Loading Screen Component - Startup Loading Interface
 * High-End "Quantum Core" Design
 *
 * @license Apache-2.0
 * Copyright 2025 Easy Code
 */

import React, { useEffect, useState, useRef, useMemo } from 'react';
import './LoadingScreen.css';

interface LoadingScreenProps {
  /** Additional CSS class name */
  className?: string;
  /** Callback when loading is complete and should proceed to main app */
  onLoadingComplete?: () => void;
  /** Callback when login is required */
  onLoginRequired?: (error?: string) => void;
}

/**
 * LoadingScreen - Startup Loading Interface Component
 *
 * 重新设计的启动协调器：
 * - 内部管理假进度条
 * - 并行执行登录检测和升级检测
 * - 等待两个检测都完成才决定下一步
 * - 根据检测结果决定进入登录页面、升级页面或主应用
 */
export const LoadingScreen: React.FC<LoadingScreenProps> = ({
  className = '',
  onLoadingComplete,
  onLoginRequired
}) => {
  // 🎯 内部进度条状态
  const [currentProgress, setCurrentProgress] = useState(0);
  const [currentStage, setCurrentStage] = useState('Initializing Neural Core...');
  const [isFadingOut, setIsFadingOut] = useState(false);

  // 🎯 三个并行任务的状态
  const [loginCheckComplete, setLoginCheckComplete] = useState(false);
  const [updateCheckComplete, setUpdateCheckComplete] = useState(false);
  const [serviceInitComplete, setServiceInitComplete] = useState(false);

  // 🎯 检测结果
  const [loginResult, setLoginResult] = useState<{ isLoggedIn: boolean; error?: string } | null>(null);

  // 🎯 1. 统一的进度条动画控制逻辑
  useEffect(() => {
    let animationFrameId: number;
    const startTime = Date.now();
    const maxDuration = 12000; // 12秒内到达98%

    const animate = () => {
      const now = Date.now();
      const allTasksComplete = loginCheckComplete && updateCheckComplete && serviceInitComplete;

      setCurrentProgress(prev => {
        // 如果已经满了，停止
        if (prev >= 100) return 100;

        let nextProgress = prev;

        if (allTasksComplete) {
          // 🚀 任务完成：平滑冲刺模式
          // 目标 100，速度优雅且克制
          // 动态步长：剩余距离的 2% + 基础速度 0.1
          // 限制最大步长为 0.8 (每帧最多 0.8%)，确保不会瞬间跳变
          const remaining = 100 - prev;
          const step = Math.min(0.8, Math.max(0.1, remaining * 0.02));
          nextProgress = prev + step;

          if (nextProgress >= 99.8) nextProgress = 100;
        } else {
          // 🐢 任务未完成：慢速等待模式
          // 使用 Sine Ease In Out 算法，但在 12秒内到 98
          const elapsed = now - startTime;
          const progressRatio = Math.min(elapsed / maxDuration, 1);

          // Sine Ease In Out
          const easedProgress = 0.5 * (1 - Math.cos(progressRatio * Math.PI));
          const target = 98;

          // 计算理论上的当前进度
          const theoreticalProgress = easedProgress * target;

          // 确保进度单调递增，且不超过 98
          // 如果理论进度比当前快，就跟上；如果比当前慢（比如之前冲刺过），就保持
          if (theoreticalProgress > prev && theoreticalProgress < 98) {
             nextProgress = theoreticalProgress;
          } else if (prev < 98) {
             // 即使时间到了，如果还没到 98，也慢慢蹭过去?
             // 不，按时间算就行。如果时间到了就停在 98。
             // 但为了防止倒退，取 max
             nextProgress = Math.max(prev, theoreticalProgress);
             if (nextProgress > 98) nextProgress = 98;
          }
        }

        return nextProgress;
      });

      animationFrameId = requestAnimationFrame(animate);
    };

    animationFrameId = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(animationFrameId);
  }, [loginCheckComplete, updateCheckComplete, serviceInitComplete]);

  // 🎯 2. 并行启动三个任务：登录检测、升级检测、服务初始化
  useEffect(() => {
    console.log('[LoadingScreen] 🚀 Starting parallel login, update, and service initialization...');

    // 🎯 A. 启动登录检测
    const startLoginCheck = async () => {
      try {
        setCurrentStage('Authenticating Neural Link...');
        console.log('[LoadingScreen] 🔍 Starting login check...');

        const hasReceivedResponse = { current: false };

        const handleLoginResponse = (data: { isLoggedIn: boolean; error?: string }) => {
          console.log('[LoadingScreen] 📄 Login check result:', data);
          hasReceivedResponse.current = true;
          setLoginResult(data);
          setLoginCheckComplete(true);
        };

        // 监听登录状态响应
        const messageHandler = (event: MessageEvent) => {
          if (event.data?.type === 'login_status_response') {
            handleLoginResponse(event.data.payload);
            window.removeEventListener('message', messageHandler);
          }
        };

        window.addEventListener('message', messageHandler);

        // 发送登录检查请求
        if (window.vscode) {
          window.vscode.postMessage({
            type: 'login_check_status' as any,
            payload: {}
          });
        }

      } catch (error) {
        console.error('[LoadingScreen] ❌ Login check failed:', error);
        setLoginResult({ isLoggedIn: false, error: 'Login check failed' });
        setLoginCheckComplete(true);
      }
    };

    // 🎯 B. 启动升级检测（禁用：市场自动升级）
    // NOTE: 更新检测已禁用，因为 VSCode 市场会自动处理扩展升级
    // 这避免了启动时的网络超时问题，并简化了启动流程
    const startUpdateCheck = async () => {
      console.log('[LoadingScreen] ⏭️ Skipping update check (marketplace handles auto-update)');
      setUpdateCheckComplete(true);
    };

    // 🎯 C. 启动服务初始化
    const startServiceInit = async () => {
      try {
        setCurrentStage('Calibrating AI Models...');
        console.log('[LoadingScreen] 🔍 Starting service initialization...');

        const handleMessage = (event: MessageEvent) => {
          if (event.data?.type === 'service_initialization_done') {
            console.log('🔍 [DEBUG-UI-FLOW] [LoadingScreen] Received service_initialization_done');
            setServiceInitComplete(true);
            window.removeEventListener('message', handleMessage);
          } else if (event.data?.type === 'sessions_ready') {
            console.log('🔍 [DEBUG-UI-FLOW] [LoadingScreen] Received sessions_ready');
            setServiceInitComplete(true);
            window.removeEventListener('message', handleMessage);
          }
        };

        window.addEventListener('message', handleMessage);

        // 发送服务初始化请求
        if (window.vscode) {
          window.vscode.postMessage({
            type: 'start_services' as any,
            payload: {}
          });
        } else {
          console.error('[LoadingScreen] ❌ VSCode API not available');
          setServiceInitComplete(true);
        }

      } catch (error) {
        console.error('[LoadingScreen] ❌ Service initialization failed:', error);
        setServiceInitComplete(true);
      }
    };

    // 🎯 D. 并行执行三个任务
    startLoginCheck();
    startUpdateCheck();
    startServiceInit();
  }, []);

  // 🎯 3. 监听任务完成状态，更新文字
  useEffect(() => {
    if (loginCheckComplete && updateCheckComplete && serviceInitComplete) {
      setCurrentStage('System Ready.');
    }
  }, [loginCheckComplete, updateCheckComplete, serviceInitComplete]);

  // 品牌自适应提示文案
  const localizedBrandNotice = useMemo(() => {
    const isZh = document.documentElement.lang?.toLowerCase().startsWith('zh') || false;
    return isZh
      ? '🎉 Otto 现已全面品牌升级为 Otto'
      : '🎉 Otto has been fully branded as Otto';
  }, []);

  // 🎯 4. 监听进度条到达 100%，执行跳转
  const hasCompletedRef = useRef(false);

  // 使用 ref 存储回调函数，避免因父组件重渲染导致回调函数引用变化，进而触发 effect 清理导致定时器被取消
  const onLoadingCompleteRef = useRef(onLoadingComplete);
  const onLoginRequiredRef = useRef(onLoginRequired);

  useEffect(() => {
    onLoadingCompleteRef.current = onLoadingComplete;
    onLoginRequiredRef.current = onLoginRequired;
  }, [onLoadingComplete, onLoginRequired]);

  useEffect(() => {
    if (currentProgress >= 100 && !hasCompletedRef.current) {
      console.log('🔍 [DEBUG-UI-FLOW] [LoadingScreen] Progress reached 100%, finalizing...');
      hasCompletedRef.current = true;

      // 立即触发淡出动画
      setIsFadingOut(true);

      // 延迟一下让淡出动画播放一小会儿，然后真正切换界面
      // 这样用户看到的是界面正在消失，而不是卡在 100%
      const timer = setTimeout(() => {
        // 🎯 优先级：登录 > 主应用
        if (loginResult && !loginResult.isLoggedIn) {
          console.log('[LoadingScreen] 🔄 Redirecting to login');
          onLoginRequiredRef.current?.(loginResult.error);
        } else {
          console.log('🔍 [DEBUG-UI-FLOW] [LoadingScreen] Redirecting to main app');
          onLoadingCompleteRef.current?.();
        }
      }, 300); // 300ms 淡出时间

      return () => clearTimeout(timer);
    }
  }, [currentProgress, loginResult]);

  // SVG Circle Configuration
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (currentProgress / 100) * circumference;

  return (
    <div className={`loading-screen ${className} ${isFadingOut ? 'loading-screen--fadeout' : ''}`}>
      <div className="loading-screen__container" style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

        {/* Brand Logo - High Precision Inline SVG with Pulsing */}
        <div className="initial-loading__logo-image" style={{ animation: 'logoPulse 2s ease-in-out infinite', display: 'flex', justifyContent: 'center', alignItems: 'center', marginBottom: '0.5rem' }}>
          <svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 256 256">
            <path d="M0 0 C5.04366982 3.69049011 8.18773022 7.75102554 9.5625 13.875 C10.38390593 20.9938514 8.11019531 27.31201027 3.984375 33.08203125 C-2.06744686 40.21064124 -9.41993723 45.72658019 -17 51.125 C-18.18625977 51.97578125 -18.18625977 51.97578125 -19.39648438 52.84375 C-21.74112518 54.52417053 -24.08882217 56.2002282 -26.4375 57.875 C-27.65501482 58.74469801 -28.87246884 59.61448116 -30.08984375 60.484375 C-31.76494253 61.68087413 -33.44030292 62.87699836 -35.11645508 64.07202148 C-42.14172575 69.08320086 -49.13042961 74.14507609 -56.12304688 79.20166016 C-59.14734728 81.38821659 -62.17271951 83.57328584 -65.19848633 85.7578125 C-66.68840501 86.83394611 -68.17782775 87.91076671 -69.66674805 88.98828125 C-73.51839968 91.77449294 -77.37854325 94.5476246 -81.25390625 97.30078125 C-95.50723315 106.16948466 -95.50723315 106.16948466 -105.4375 118.875 C-105.7876323 121.06337223 -105.7876323 121.06337223 -105.75 123.3125 C-105.76675781 124.05371094 -105.78351563 124.79492188 -105.80078125 125.55859375 C-104.54448159 133.56919266 -96.35345252 138.72430368 -90.296875 143.19140625 C-87.94980169 144.87066588 -85.58833806 146.52901288 -83.2265625 148.1875 C-79.34221357 150.92324032 -75.54156834 153.76258511 -71.75 156.625 C-66.54377124 160.55384266 -61.31267903 164.44501304 -56.05151367 168.30004883 C-43.89188973 177.21551611 -43.89188973 177.21551611 -38.4375 181.4375 C-37.715625 181.99566406 -36.99375 182.55382812 -36.25 183.12890625 C-33.9761479 185.31944912 -32.59502954 186.90883056 -31.4375 189.875 C-33.00357473 195.94269213 -35.88279425 198.59231809 -41 201.9375 C-41.62261719 202.36087646 -42.24523437 202.78425293 -42.88671875 203.22045898 C-44.72441501 204.45906059 -46.57752584 205.67019162 -48.4375 206.875 C-49.40558594 207.514375 -50.37367187 208.15375 -51.37109375 208.8125 C-59.53837668 213.98386941 -59.53837668 213.98386941 -64.4375 213.875 C-69.73676611 211.92129466 -73.90112494 209.34498443 -78.375 205.9375 C-79.02049805 205.45514893 -79.66599609 204.97279785 -80.33105469 204.47583008 C-82.37161599 202.94885433 -84.40475997 201.41236641 -86.4375 199.875 C-87.72475675 198.9081832 -89.01251071 197.94202803 -90.30078125 196.9765625 C-92.25814407 195.50959034 -94.21490445 194.04187155 -96.16918945 192.57080078 C-100.62860799 189.21669902 -105.11561342 185.90250137 -109.6171875 182.60522461 C-147.5283814 154.81150488 -147.5283814 154.81150488 -152.0625 131.6875 C-153.52162572 116.85305518 -151.35557234 102.39741536 -142.1875 90.1875 C-140.95851821 88.73198978 -139.70825616 87.29418464 -138.4375 85.875 C-137.55578125 84.83666016 -137.55578125 84.83666016 -136.65625 83.77734375 C-130.46623286 77.01008295 -122.92024527 72.2620372 -115.34765625 67.203125 C-110.88948828 64.21307038 -106.58138898 61.06534316 -102.3125 57.8125 C-96.27291808 53.22130417 -90.13922063 48.7943264 -83.92651367 44.44067383 C-78.79171648 40.83995782 -73.70021012 37.18414015 -68.625 33.5 C-59.76568562 27.07940974 -50.818072 20.79046454 -41.83300781 14.54736328 C-39.5128201 12.92758283 -37.20445547 11.29221242 -34.8984375 9.65234375 C-33.49491819 8.66388283 -32.09127904 7.67559203 -30.6875 6.6875 C-30.06858887 6.24196777 -29.44967773 5.79643555 -28.81201172 5.33740234 C-20.04673517 -0.78804642 -10.48828604 -3.43252998 0 0 Z" fill="var(--vscode-textLink-foreground, #8E89FE)" transform="translate(160.4375,5.125)"/>
            <path d="M0 0 C4.37052037 1.74820815 7.75108026 4.85253571 10 9 C12.80713348 18.17614858 12.13733409 26.3613377 8.4375 35.125 C3.35115202 44.30970032 -6.98808635 49.95061457 -15.3984375 55.7890625 C-19.99908185 58.98466106 -24.53249119 62.26790364 -29.0625 65.5625 C-63.31611821 90.34793954 -63.31611821 90.34793954 -83 89 C-94.11068412 86.83918364 -104.40929278 79.13290059 -112 71 C-114.399545 67.40068251 -114.81480111 66.23696577 -114 62 C-112.4855957 60.39526367 -112.4855957 60.39526367 -110.48828125 58.73046875 C-109.7602832 58.12025879 -109.03228516 57.51004883 -108.28222656 56.88134766 C-107.5290918 56.26050293 -106.77595703 55.6396582 -106 55 C-105.31647461 54.41138184 -104.63294922 53.82276367 -103.92871094 53.21630859 C-89.85389919 41.24366621 -89.85389919 41.24366621 -81.3828125 41.56152344 C-79.95953085 41.68729879 -78.536353 41.81425432 -77.11328125 41.94238281 C-69.44052669 42.48075918 -64.71371254 38.97459354 -58.87353516 34.44189453 C-56.86915212 32.89929794 -54.82425604 31.42868453 -52.76171875 29.96484375 C-48.14534928 26.68264138 -43.57133833 23.34451028 -39 20 C-33.67020897 16.10569936 -28.33075596 12.22669352 -22.95361328 8.39794922 C-21.7329088 7.52444836 -20.51688645 6.64432246 -19.30810547 5.75439453 C-12.9652326 1.09081496 -7.98887516 -1.56587753 0 0 Z" fill="var(--vscode-textLink-foreground, #8E89FE)" transform="translate(223,162)"/>
            <path d="M0 0 C1.88671875 0.26171875 1.88671875 0.26171875 4 1 C5.01953125 2.64453125 5.01953125 2.64453125 5.8125 4.8125 C11.99291988 19.79822852 19.71165088 28.11714815 34.62890625 34.578125 C37 36 37 36 37.83984375 38.171875 C37.89269531 38.77515625 37.94554687 39.3784375 38 40 C34.65606612 42.75480409 31.10729303 44.43237116 27.1875 46.25 C15.9449659 51.78463052 11.88861973 58.40493502 6.69921875 69.453125 C5 73 5 73 3 76 C1.1184082 75.70727539 1.1184082 75.70727539 -1 75 C-2.43817102 72.48245939 -3.64144199 70.07399639 -4.8125 67.4375 C-9.95927384 56.59652491 -15.41056424 50.78054736 -26 45 C-27.55053723 44.14081701 -29.09311662 43.26701705 -30.625 42.375 C-31.27726562 42.01148438 -31.92953125 41.64796875 -32.6015625 41.2734375 C-33.06304687 40.85320312 -33.52453125 40.43296875 -34 40 C-34 38.68 -34 37.36 -34 36 C-32.865625 35.45472656 -31.73125 34.90945312 -30.5625 34.34765625 C-16.46094311 27.37270944 -9.61106595 20.45073707 -3 6 C-2.00651993 3.9967533 -1.00827049 1.99584334 0 0 Z" fill="var(--vscode-textLink-foreground, #8E89FE)" transform="translate(146,90)"/>
          </svg>
        </div>

        {/* Minimalist Flat Progress Bar driven by React currentProgress */}
        <div className="initial-loading__progress-bar" style={{ width: '120px', height: '2px', background: 'rgba(255, 255, 255, 0.08)', margin: '1rem auto 1.2rem', borderRadius: '1px', overflow: 'hidden', position: 'relative' }}>
          <div
            className="initial-loading__progress-indicator"
            style={{
              height: '100%',
              background: '#3794ff',
              width: `${currentProgress}%`,
              transition: 'width 0.2s ease-out',
              borderRadius: '1px',
              position: 'absolute',
              top: 0,
              left: 0
            }}
          />
        </div>

        {/* Text Info */}
        <div className="loading-info" style={{ marginTop: '1.2rem' }}>
          <h1 className="app-title" style={{ fontSize: '1.2rem', fontWeight: 500, margin: '0 0 0.3rem', letterSpacing: '0.5px' }}>Otto</h1>
          <div className="app-subtitle" style={{ fontSize: '0.8rem', margin: '0 0 1rem', color: 'rgba(255, 255, 255, 0.6)' }}>for VS Code</div>

          <div className="status-text" style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '0.5rem' }}>
            {currentStage}
          </div>

          <div className="percentage-display" style={{
            fontSize: '0.8rem',
            fontWeight: 600,
            color: 'var(--vscode-foreground, #cccccc)',
            opacity: 0.85,
            marginBottom: '0.5rem'
          }}>
            {Math.round(currentProgress)}%
          </div>
        </div>

        {/* 品牌升级公告 */}
        <div style={{
          fontSize: '0.75rem',
          color: 'var(--vscode-textLink-foreground, #3794ff)',
          marginTop: '0.5rem',
          maxWidth: '280px',
          lineHeight: '1.4',
          fontWeight: 500,
          opacity: 0.85
        }}>
          {localizedBrandNotice}
        </div>

      </div>
    </div>
  );
};