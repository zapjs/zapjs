#!/usr/bin/env node
/**
 * Fastify Benchmark Server
 *
 * High-performance Node.js framework comparison
 */

const fastify = require('fastify')({ logger: false });

const PORT = parseInt(process.env.PORT || '3002');

// Hello World - simplest possible route
fastify.get('/', async (request, reply) => {
    return 'Hello, World!';
});

// Health check
fastify.get('/health', async (request, reply) => {
    return { status: 'ok' };
});

// JSON API - GET with dynamic parameter
fastify.get('/api/users/:id', async (request, reply) => {
    const { id } = request.params;
    return {
        id,
        name: 'John Doe',
        email: `user${id}@example.com`,
        role: 'user'
    };
});

// JSON API - List
fastify.get('/api/users', async (request, reply) => {
    return {
        users: Array.from({ length: 10 }, (_, i) => ({
            id: i + 1,
            name: `User ${i + 1}`,
            email: `user${i + 1}@example.com`
        })),
        total: 10,
        page: 1
    };
});

// POST with body parsing
fastify.post('/api/users', async (request, reply) => {
    return {
        message: 'User created',
        user: request.body,
        id: Math.floor(Math.random() * 10000)
    };
});

// Nested parameters
fastify.get('/api/users/:userId/posts/:postId', async (request, reply) => {
    const { userId, postId } = request.params;
    return {
        userId,
        postId,
        title: 'Sample Post',
        content: 'Lorem ipsum dolor sit amet'
    };
});

const start = async () => {
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`⚡ Fastify server running on http://localhost:${PORT}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
