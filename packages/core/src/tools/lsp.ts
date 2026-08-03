/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { BaseTool, Icon, ToolResult } from './tools.js';
import { Config } from '../config/config.js';
import { getLSPManager } from './lsp/lsp-provider.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';

interface LspToolParams {
    operation: 'goToDefinition' | 'findReferences' | 'hover' | 'documentSymbol' | 'workspaceSymbol' | 'goToImplementation';
    filePath?: string;
    line?: number;
    character?: number;
    query?: string;
}

export class LspTool extends BaseTool<LspToolParams, ToolResult> {
    static readonly Name = 'lsp';

    constructor(private readonly config: Config) {
        super(
            LspTool.Name,
            'LSP Tool',
            'Perform Language Server Protocol operations like Go to Definition, Find References, Hover, etc. Useful for code navigation and understanding.',
            Icon.LightBulb,
            {
                properties: {
                    operation: {
                        type: Type.STRING,
                        enum: [
                            'goToDefinition',
                            'findReferences',
                            'hover',
                            'documentSymbol',
                            'workspaceSymbol',
                            'goToImplementation',
                        ],
                        description: 'The LSP operation to perform.',
                    },
                    filePath: {
                        type: Type.STRING,
                        description: 'The absolute path to the file. Required for file-specific operations.',
                    },
                    line: {
                        type: Type.NUMBER,
                        description: 'The 1-based line number. Required for position-specific operations.',
                    },
                    character: {
                        type: Type.NUMBER,
                        description: 'The 1-based character offset. Required for position-specific operations.',
                    },
                    query: {
                        type: Type.STRING,
                        description: 'Search query. Required for workspaceSymbol.',
                    },
                },
                required: ['operation'],
                type: Type.OBJECT,
            }
        );
    }

    validateToolParams(params: LspToolParams): string | null {
        const errors = SchemaValidator.validate(this.schema.parameters, params, LspTool.Name);
        if (errors) return errors;

        if (params.operation !== 'workspaceSymbol') {
            if (!params.filePath || !path.isAbsolute(params.filePath)) {
                return 'filePath must be an absolute path for this operation.';
            }
        }

        if (['goToDefinition', 'findReferences', 'hover', 'goToImplementation'].includes(params.operation)) {
            if (!params.line || !params.character || params.line < 1 || params.character < 1) {
                return 'line and character must be 1-based (>= 1) for this operation.';
            }
        }

        if (params.operation === 'workspaceSymbol' && !params.query) {
            return 'query is required for workspaceSymbol.';
        }

        return null;
    }

    async execute(params: LspToolParams): Promise<ToolResult> {
        const manager = getLSPManager(this.config.getTargetDir());
        let result: unknown = null;

        // Normalize file path for Windows compatibility
        // Some LSPs or URI converters (like vscode-uri) are sensitive to casing and separators
        const targetFile = params.filePath ? path.resolve(params.filePath) : undefined;
        // On Windows, drive letters might need consistent casing. path.resolve usually helps.

        try {
            switch (params.operation) {
                case 'goToDefinition':
                    result = await manager.getDefinition(targetFile!, params.line! - 1, params.character! - 1);
                    break;
                case 'findReferences':
                    result = await manager.getReferences(targetFile!, params.line! - 1, params.character! - 1);
                    break;
                case 'hover':
                    result = await manager.getHover(targetFile!, params.line! - 1, params.character! - 1);
                    break;
                case 'documentSymbol':
                    result = await manager.getDocumentSymbols(targetFile!);
                    break;
                case 'workspaceSymbol':
                    result = await manager.getWorkspaceSymbols(params.query || '');
                    break;
                case 'goToImplementation':
                    result = await manager.getImplementation(targetFile!, params.line! - 1, params.character! - 1);
                    break;
                default:
                    throw new Error(`Unknown operation: ${params.operation}`);
            }

            // LSPManager returns an array of results (one per client).
            // We need to normalize this into a single result structure for display.
            let normalizedResult = result;

            if (Array.isArray(result)) {
                if (params.operation === 'hover') {
                    // For hover, usually only one client responds or we just want the first valid one
                    // result is Hover[]
                    const firstHover = result.find((r) => r && typeof r === 'object' && 'contents' in r);
                    normalizedResult = firstHover || null;
                } else if (params.operation === 'goToDefinition') {
                    // result is (Location | Location[])[]
                    // We want Location[] or Location (if single)
                    const flattened = result.flat().filter(Boolean);
                    // If all definitions point to the same place, maybe dedup?
                    // For now just return all.
                    normalizedResult = flattened.length === 0 ? null : flattened.length === 1 ? flattened[0] : flattened;
                } else {
                    // For lists (references, symbols), flatten the results from all clients
                    // result is List[] -> List (which is Array)
                    const listResult = result.flat().filter(Boolean);
                    normalizedResult = listResult;
                    // Ensure it's empty array if no results, not null, to match array logic
                    if (listResult.length === 0 && Array.isArray(result)) normalizedResult = [];
                }
            }

            const formattedOutput = this.formatLspResult(normalizedResult, params.operation, this.config.getTargetDir());

            return {
                llmContent: `Operation ${params.operation} result:\n${formattedOutput}`,
                returnDisplay: formattedOutput
            };

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return {
                llmContent: `Error executing LSP operation ${params.operation}: ${errorMsg}`,
                returnDisplay: `Error: ${errorMsg}`
            };
        }
    }

    private formatLspResult(result: unknown, operation: string, cwd: string): string {
        if (!result) return 'No result found.';

        // Helper to format a single location
        const formatLocation = (uri: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
            let filePath = uri;
            if (uri.startsWith('file://')) {
                filePath = fileURLToPath(uri);
            }
            const relativePath = path.relative(cwd, filePath);

            // Format: path/to/file:Line:StartCol-EndCol
            // LSP is 0-indexed, display as 1-indexed
            const startLine = range.start.line + 1;
            const startChar = range.start.character + 1;
            const endLine = range.end.line + 1;
            const endChar = range.end.character + 1;

            if (startLine === endLine) {
                return `${relativePath}:${startLine}:${startChar}-${endChar}`;
            }
            return `${relativePath}:${startLine}:${startChar} - ${endLine}:${endChar}`;
        };

        // Handle Array results (References, Symbols, or Definition array)
        if (Array.isArray(result)) {
            if (result.length === 0) return 'No results.';

            // Check content type based on first item
            const first = result[0] as Record<string, unknown>;

            // Locations (References, Definitions)
            if (typeof first.uri === 'string' || typeof first.targetUri === 'string') { // Location or LocationLink
                return result.map((item) => {
                    const record = item as Record<string, unknown>;
                    const uri = (record.uri || record.targetUri) as string;
                    const range = (record.range || record.targetSelectionRange) as { start: { line: number; character: number }; end: { line: number; character: number } };
                    return `• ${formatLocation(uri, range)}`;
                }).join('\n');
            }

            // Symbols (DocumentSymbol, SymbolInformation)
            // SymbolInformation has { name, kind, location }
            // DocumentSymbol has { name, kind, range, children? }
            if (typeof first.name === 'string' && first.kind !== undefined) {
                return result.map((item) => {
                    const record = item as Record<string, unknown>;
                    const kindMap: { [key: number]: string } = {
                        1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class',
                        6: 'Method', 7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum',
                        11: 'Interface', 12: 'Function', 13: 'Variable', 14: 'Constant', 15: 'String'
                    };
                    const kindNumber = Number(record.kind);
                    const kind = kindMap[kindNumber] || `Kind(${kindNumber})`;
                    let locStr = '';
                    if (record.location && typeof record.location === 'object') { // SymbolInformation
                        const location = record.location as Record<string, unknown>;
                        locStr = formatLocation(String(location.uri), location.range as { start: { line: number; character: number }; end: { line: number; character: number } });
                    } else if (record.range) { // DocumentSymbol - usually implicitly current file if nested, but top level passed raw
                        // DocumentSymbol doesn't have URI usually if nested, but here we might just show range
                        // However, for document symbols we typically just list them.
                        const r = record.range as { start: { line: number; character: number } };
                        locStr = `${r.start.line + 1}:${r.start.character + 1}`;
                    }
                    return `• [${kind}] ${String(record.name)} (${locStr})`;
                }).join('\n');
            }

            // Fallback for array
            return `Found ${result.length} items. (Use getting 'view_file' to see details if needed)`;
        }

        // Handle Single Object results

        const resultRecord = result as Record<string, unknown>;
        // Hover
        if (resultRecord.contents) {
            if (typeof resultRecord.contents === 'string') return resultRecord.contents;
            if (resultRecord.contents && typeof resultRecord.contents === 'object' && 'value' in resultRecord.contents) return String((resultRecord.contents as { value?: unknown }).value ?? ''); // MarkupContent
            if (Array.isArray(resultRecord.contents)) {
                return resultRecord.contents.map((c) => typeof c === 'string' ? c : String((c as { value?: unknown }).value ?? '')).join('\n\n');
            }
            return 'Hover content available.';
        }

        // Single Location (Definition)
        if (typeof resultRecord.uri === 'string' || typeof resultRecord.targetUri === 'string') {
            const uri = String(resultRecord.uri || resultRecord.targetUri);
            const range = (resultRecord.range || resultRecord.targetSelectionRange) as { start: { line: number; character: number }; end: { line: number; character: number } };
            return formatLocation(uri, range);
        }

        return JSON.stringify(result, null, 2);
    }
}
