export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocationLike {
  uri?: string;
  targetUri?: string;
  range?: LspRange;
  targetSelectionRange?: LspRange;
  location?: { uri: string; range: LspRange };
  name?: string;
  kind?: number;
}

export interface LspHoverContent {
  contents?: string | Array<string | { value: string }> | { value: string };
}
