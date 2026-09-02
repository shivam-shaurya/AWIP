import swaggerJsdoc from 'swagger-jsdoc';

// Auto-generated from @swagger JSDoc comments above each route in server.js —
// this file only holds the shared spec metadata (info, servers, auth scheme),
// not the per-route definitions themselves.
const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'AWIP Core API',
      version: '1.0.0',
      description: 'AWIP (AI Workforce Intelligence Platform) — server-core REST API. Import /api-docs.json into Postman for a ready-made collection.',
    },
    servers: [
      { url: 'http://localhost:5000', description: 'Local dev' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Token returned by POST /api/v1/auth/login',
        },
      },
    },
  },
  apis: ['./server.js'],
};

export const swaggerSpec = swaggerJsdoc(options);
