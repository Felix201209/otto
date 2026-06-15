/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { getModelCapabilities, ModelCapabilities } from '../config/modelCapabilities.js';

/**
 * Diagnostic utilities for model capability analysis and debugging
 */

export interface ModelDiagnosticInfo {
  modelName: string;
  capabilities: ModelCapabilities;
  recommendations: string[];
  warnings: string[];
  isSmallModel: boolean;
  needsSpecialHandling: boolean;
}

/**
 * Get comprehensive diagnostic information for a model
 * @param modelName - Name of the model to analyze
 * @returns Diagnostic information
 */
export function getModelDiagnostics(modelName: string): ModelDiagnosticInfo {
  const capabilities = getModelCapabilities(modelName);
  const recommendations: string[] = [];
  const warnings: string[] = [];

  const isSmallModel = capabilities.toolCallReliability === 'low' ||
                      capabilities.needsFormatTolerance;

  const needsSpecialHandling = capabilities.needsFormatTolerance ||
                              capabilities.proneToIncompleteStream ||
                              capabilities.enableMalformedRetry;

  // Generate recommendations based on capabilities
  if (capabilities.toolCallReliability === 'low') {
    recommendations.push('Consider using sequential tool calls instead of concurrent ones');
    recommendations.push('Enable debug logging to monitor tool call success rates');
  }

  if (capabilities.needsFormatTolerance) {
    recommendations.push('Tolerant parameter validation is enabled for this model');
    recommendations.push('Consider upgrading to a more capable model for production use');
  }

  if (capabilities.proneToIncompleteStream) {
    recommendations.push('Streaming responses may be incomplete - validation and retry enabled');
    warnings.push('Function calls may require automatic fixing during streaming');
  }

  if (capabilities.maxConcurrentTools < 3) {
    warnings.push(`Concurrent tool calls limited to ${capabilities.maxConcurrentTools} for stability`);
  }

  if (capabilities.enableMalformedRetry) {
    recommendations.push('Automatic retry enabled for malformed function calls');
  }

  if (capabilities.enableProgressiveDegradation) {
    recommendations.push('Progressive degradation enabled - will reduce complexity on failures');
  }

  return {
    modelName,
    capabilities,
    recommendations,
    warnings,
    isSmallModel,
    needsSpecialHandling,
  };
}

/**
 * Log model diagnostics to console
 * @param modelName - Name of the model
 * @param verbose - Whether to show detailed information
 */
export function logModelDiagnostics(modelName: string, verbose: boolean = false): void {
  const diagnostics = getModelDiagnostics(modelName);

  console.log(`\n🔍 Model Diagnostics: ${modelName}`);
  console.log(`📊 Reliability: ${diagnostics.capabilities.toolCallReliability}`);
  console.log(`🔧 Format Tolerance: ${diagnostics.capabilities.needsFormatTolerance ? 'Yes' : 'No'}`);
  console.log(`🔄 Max Concurrent Tools: ${diagnostics.capabilities.maxConcurrentTools}`);

  if (diagnostics.warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    diagnostics.warnings.forEach(warning => console.log(`  • ${warning}`));
  }

  if (verbose && diagnostics.recommendations.length > 0) {
    console.log('\n💡 Recommendations:');
    diagnostics.recommendations.forEach(rec => console.log(`  • ${rec}`));
  }

  if (verbose) {
    console.log('\n📋 Full Capabilities:');
    console.log(JSON.stringify(diagnostics.capabilities, null, 2));
  }
}

/**
 * Check if debugging should be enabled for a model
 * @param modelName - Name of the model
 * @returns True if debugging is recommended
 */
export function shouldEnableDebugForModel(modelName: string): boolean {
  const diagnostics = getModelDiagnostics(modelName);
  return diagnostics.isSmallModel || diagnostics.needsSpecialHandling;
}

/**
 * Get a user-friendly status message for model compatibility
 * @param modelName - Name of the model
 * @returns Status message
 */
export function getModelCompatibilityStatus(modelName: string): string {
  const diagnostics = getModelDiagnostics(modelName);

  if (diagnostics.capabilities.toolCallReliability === 'high') {
    return '✅ Excellent tool calling compatibility';
  } else if (diagnostics.capabilities.toolCallReliability === 'medium') {
    return '🟡 Good compatibility with enhanced error handling';
  } else {
    return '🟠 Limited compatibility - enhanced robustness features active';
  }
}