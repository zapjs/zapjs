#!/usr/bin/env node
/**
 * Express.js Benchmark Server
 *
 * Baseline comparison - the most popular Node.js framework
 */

const express = require('express');
const app = express();

const PORT = parseInt(process.env.PORT || '3001');

// Middleware
app.use(express.json());

// Hello World - simplest possible route
app.get('/', (req, res) => {
    res.send('Hello, World!');
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// JSON API - GET with dynamic parameter
app.get('/api/users/:id', (req, res) => {
    res.json({
        id: req.params.id,
        name: 'John Doe',
        email: `user${req.params.id}@example.com`,
        role: 'user'
    });
});

// JSON API - List
app.get('/api/users', (req, res) => {
    res.json({
        users: Array.from({ length: 10 }, (_, i) => ({
            id: i + 1,
            name: `User ${i + 1}`,
            email: `user${i + 1}@example.com`
        })),
        total: 10,
        page: 1
    });
});

// POST with body parsing
app.post('/api/users', (req, res) => {
    res.json({
        message: 'User created',
        user: req.body,
        id: Math.floor(Math.random() * 10000)
    });
});

// Nested parameters
app.get('/api/users/:userId/posts/:postId', (req, res) => {
    res.json({
        userId: req.params.userId,
        postId: req.params.postId,
        title: 'Sample Post',
        content: 'Lorem ipsum dolor sit amet'
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`📦 Express.js server running on http://localhost:${PORT}`);
});
