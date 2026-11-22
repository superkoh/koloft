export declare const projectHeader: (realDir: string) => string
export declare const hookStateHeader: (key: string) => string
export declare const trustedHashLine: (hash: string) => string
export declare function tableEnd(lines: string[], start: number): number
export declare function appendTable(text: string, table: string): string
export declare function folderTrustLevel(text: string, realDir: string): string | undefined
export declare const withTrustedFolder: (text: string, realDir: string) => string
export declare const hookTrusted: (text: string, key: string, hash: string) => boolean
export declare const withTrustedHash: (text: string, key: string, hash: string) => string
