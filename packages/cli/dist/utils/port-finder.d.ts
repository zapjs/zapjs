/**
 * Find an available port starting from the given port
 */
export declare function findAvailablePort(startPort: number, maxAttempts?: number): Promise<number>;
/**
 * Find multiple available ports
 */
export declare function findAvailablePorts(ports: number[]): Promise<Record<string, number>>;
//# sourceMappingURL=port-finder.d.ts.map