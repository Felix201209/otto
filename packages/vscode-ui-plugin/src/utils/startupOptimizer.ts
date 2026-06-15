/**
 * Startup Optimizer - 启动性能优化工具
 *
 * @license Apache-2.0
 * Copyright 2025 Easy Code
 */

import { singletonRegistry } from './singletonRegistry';

interface StartupMetrics {
  startTime: number;
  phases: Array<{
    name: string;
    startTime: number;
    endTime?: number;
    duration?: number;
  }>;
}

class StartupOptimizer {
  private static instance: StartupOptimizer;
  private metrics: StartupMetrics;
  private currentPhase: string | null = null;
  private logger: any = null;

  private constructor() {
    this.metrics = {
      startTime: Date.now(),
      phases: []
    };
  }

  /**
   * 设置 logger 引用（在 logger 初始化后调用）
   */
  setLogger(logger: any): void {
    this.logger = logger;
  }

  static getInstance(): StartupOptimizer {
    return singletonRegistry.getOrCreate('StartupOptimizer', () => {
      if (!StartupOptimizer.instance) {
        StartupOptimizer.instance = new StartupOptimizer();
      }
      return StartupOptimizer.instance;
    });
  }

  /**
   * 开始一个启动阶段
   */
  startPhase(name: string): void {
    // 结束当前阶段
    if (this.currentPhase) {
      this.endPhase();
    }

    const msg = `[Startup] Starting phase: ${name}`;
    if (this.logger) {
      this.logger.info(msg);
    } else {
      console.log(`🚀 ${msg}`);
    }
    this.currentPhase = name;
    this.metrics.phases.push({
      name,
      startTime: Date.now()
    });
  }

  /**
   * 结束当前阶段
   */
  endPhase(): void {
    if (!this.currentPhase) return;

    const currentPhaseData = this.metrics.phases[this.metrics.phases.length - 1];
    if (currentPhaseData && !currentPhaseData.endTime) {
      currentPhaseData.endTime = Date.now();
      currentPhaseData.duration = currentPhaseData.endTime - currentPhaseData.startTime;

      const msg = `[Startup] Completed phase: ${this.currentPhase} (${currentPhaseData.duration}ms)`;
      if (this.logger) {
        this.logger.info(msg);
      } else {
        console.log(`✅ ${msg}`);
      }
      this.currentPhase = null;
    }
  }

  /**
   * 获取启动统计信息
   */
  getMetrics(): StartupMetrics & { totalDuration: number } {
    // 确保当前阶段已结束
    if (this.currentPhase) {
      this.endPhase();
    }

    const totalDuration = Date.now() - this.metrics.startTime;

    return {
      ...this.metrics,
      totalDuration
    };
  }

  /**
   * 输出性能报告
   */
  logPerformanceReport(): void {
    const metrics = this.getMetrics();

    console.log('\n📊 ===== Startup Performance Report =====');
    console.log(`🕐 Total startup time: ${metrics.totalDuration}ms`);
    console.log('\n📋 Phase breakdown:');

    metrics.phases.forEach((phase, index) => {
      const duration = phase.duration || 0;
      const percentage = metrics.totalDuration > 0 ? (duration / metrics.totalDuration * 100).toFixed(1) : '0.0';
      console.log(`  ${index + 1}. ${phase.name}: ${duration}ms (${percentage}%)`);
    });

    // 单例统计
    const singletonStats = singletonRegistry.getStats();
    if (singletonStats.length > 0) {
      console.log('\n🔄 Singleton access stats:');
      singletonStats.forEach(stat => {
        console.log(`  ${stat.key}: accessed ${stat.initCount} times, age ${stat.age}ms`);
      });
    }

    console.log('=======================================\n');
  }

  /**
   * 检查是否有性能问题
   */
  checkPerformanceIssues(): Array<{ severity: 'warning' | 'error'; message: string }> {
    const issues: Array<{ severity: 'warning' | 'error'; message: string }> = [];
    const metrics = this.getMetrics();

    // 检查总启动时间
    if (metrics.totalDuration > 10000) {
      issues.push({
        severity: 'error',
        message: `启动时间过长: ${metrics.totalDuration}ms > 10s`
      });
    } else if (metrics.totalDuration > 5000) {
      issues.push({
        severity: 'warning',
        message: `启动时间较长: ${metrics.totalDuration}ms > 5s`
      });
    }

    // 检查单个阶段耗时
    metrics.phases.forEach(phase => {
      if (phase.duration && phase.duration > 3000) {
        issues.push({
          severity: 'warning',
          message: `阶段 "${phase.name}" 耗时过长: ${phase.duration}ms`
        });
      }
    });

    // 检查单例重复访问
    const singletonStats = singletonRegistry.getStats();
    singletonStats.forEach(stat => {
      if (stat.initCount > 5) {
        issues.push({
          severity: 'warning',
          message: `单例 "${stat.key}" 被过度访问: ${stat.initCount} 次`
        });
      }
    });

    return issues;
  }
}

// 创建全局实例并开始记录
const optimizer = StartupOptimizer.getInstance();
optimizer.startPhase('Extension Activation');

export { StartupOptimizer, optimizer as startupOptimizer };