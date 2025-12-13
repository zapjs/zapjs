#!/usr/bin/env bun
/**
 * ZapJS Benchmark Server
 *
 * Implements standard benchmark routes for comparison testing
 */

import { Zap } from '@zap-js/server';

const PORT = parseInt(process.env.PORT || '3000');

const server = Zap.new()
    .port(PORT)
    .hostname('127.0.0.1')

    // Hello World - simplest possible route
    .get('/', () => 'Hello, World!')

    // Health check
    .get('/health', () => ({ status: 'ok' }))

    // JSON API - GET with dynamic parameter
    .get('/api/users/:id', (req) => ({
        id: req.param('id'),
        name: 'John Doe',
        email: `user${req.param('id')}@example.com`,
        role: 'user'
    }))

    // JSON API - List
    .get('/api/users', () => ({
        users: Array.from({ length: 10 }, (_, i) => ({
            id: i + 1,
            name: `User ${i + 1}`,
            email: `user${i + 1}@example.com`
        })),
        total: 10,
        page: 1
    }))

    // POST with body parsing
    .post('/api/users', (req) => {
        const body = req.body_json();
        return {
            message: 'User created',
            user: body,
            id: Math.floor(Math.random() * 10000)
        };
    })

    // Nested parameters
    .get('/api/users/:userId/posts/:postId', (req) => ({
        userId: req.param('userId'),
        postId: req.param('postId'),
        title: 'Sample Post',
        content: 'Lorem ipsum dolor sit amet'
    }));

console.log(`🚀 ZapJS server running on http://localhost:${PORT}`);
server.listen().await;
