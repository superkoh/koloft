export declare const tableHeader: (kind: 'projects' | 'hooks.state', key: string) => string
export declare function tableEnd(lines: string[], start: number): number
export declare function tableBody(text: string, header: string): string[] | undefined
export declare function appendTable(text: string, table: string): string
export declare function withTableLine(
  text: string,
  header: string,
  line: string,
  keyOfLine: RegExp
): string
