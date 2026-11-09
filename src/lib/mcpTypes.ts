export interface McpPolicy {id:string;projectKey:string;typeName:string;targetStatus:string;requireResolution:boolean;steps:{from:string;transitionId:string;to:string;fields:Record<string,string|string[]>}[]}
export interface McpGrant {id:string;name:string;user:string;projects:string[];access:'read'|'write';enabled:boolean;revoked?:boolean;connected:boolean;attachmentRoots:string[];createdAt:string}
export interface McpOperation {id:string;grantId:string;agentName:string;tool:string;state:string;createdAt:string;updatedAt?:string;result?:unknown;results?:unknown[];error?:{code:string;message:string}}
export interface McpStatus {enabled:boolean;policies:McpPolicy[];url:string;running:number;activeRequests:number;persistent:boolean;grants:McpGrant[];operations:McpOperation[]}
