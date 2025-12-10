import { createServer } from 'net';
/**
 * Find an available port starting from the given port
 */
export async function findAvailablePort(startPort, maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i++) {
        const port = startPort + i;
        if (await isPortAvailable(port)) {
            return port;
        }
    }
    // If no port found, just return the original
    return startPort;
}
/**
 * Check if a port is available
 */
function isPortAvailable(port) {
    return new Promise((resolve) => {
        const server = createServer();
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(false);
            }
            else {
                resolve(false);
            }
        });
        server.once('listening', () => {
            server.close();
            resolve(true);
        });
        server.listen(port, '127.0.0.1');
    });
}
/**
 * Find multiple available ports
 */
export async function findAvailablePorts(ports) {
    const result = {};
    let currentPort = Math.min(...ports);
    for (const originalPort of ports) {
        const available = await findAvailablePort(currentPort);
        result[`port_${originalPort}`] = available;
        currentPort = available + 1;
    }
    return result;
}
//# sourceMappingURL=port-finder.js.map