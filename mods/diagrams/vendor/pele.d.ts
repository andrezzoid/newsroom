// The part of Pele 1.9.0's declarations (dist/*.d.ts) that the mod uses,
// gathered in one file beside pele.js. NOTICE says where they come from.

export type DiagramType = 'flowchart' | 'sequence' | 'class' | 'state' | 'er' | 'pie' | 'gantt' | 'gitGraph' | 'mindmap' | 'timeline' | 'journey' | 'xychart' | 'quadrantChart' | 'requirement' | 'c4' | 'sankey' | 'block' | 'packet' | 'kanban' | 'architecture' | 'radar' | 'treemap' | 'info' | 'agentflow' | 'usecase' | 'railroad' | 'treeView' | 'venn' | 'cynefin' | 'wardley' | 'swimlane' | 'ishikawa' | 'eventmodeling';

export type PeleErrorCode = 'unsupported-diagram' | 'syntax' | 'semantic' | 'limit';
export declare class PeleError extends Error {
    code: PeleErrorCode;
    type: string | null;
    mermaidType: string | null;
    line: number;
    column: number;
    snippet: string;
    constructor(message: string, code?: PeleErrorCode, info?: {
        type?: string | null;
        mermaidType?: string | null;
        line?: number;
        column?: number;
        snippet?: string;
    });
}

export interface RenderOptions {
    fontFamily?: string;
    fontFamilyMono?: string;
    fontSize?: number;
    idPrefix?: string;
    responsive?: boolean;
    maxWidth?: number;
    padding?: number;
    limit?: number;
    outputLimit?: number;
    maxEdges?: number;
    links?: boolean;
    images?: boolean;
}
export interface RenderResult {
    svg: string;
    width: number;
    height: number;
    type: DiagramType;
    mermaidType: string;
}
export declare function render(source: string, options?: RenderOptions): RenderResult;
