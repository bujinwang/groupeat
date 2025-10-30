# GroupEat 架构审查报告

## 执行摘要

GroupEat 是一个基于 Node.js/Express + Prisma + PostgreSQL 的单体后端应用，配合计划中的 React Native 前端。当前代码库处于早期阶段，虽然核心功能已实现，但在架构设计、代码组织、安全性和可扩展性方面存在多个需要改进的关键领域。

---

## 1. 架构层次 & 代码组织

### 🔴 严重问题：缺少分层架构

**当前状态：**
```
routes/ (路由层)
  ↓ 直接调用
Prisma Client (数据访问层)
```

**问题：**
- 所有业务逻辑都写在路由处理器中（胖路由）
- 数据库操作直接在路由中执行
- 没有业务逻辑复用
- 测试困难（无法单独测试业务逻辑）
- 违反单一职责原则

**推荐架构：**
```
routes/          # 路由定义 + 请求/响应处理
  ↓
controllers/     # 请求验证 + 调用服务
  ↓
services/        # 业务逻辑层
  ↓
repositories/    # 数据访问层（封装 Prisma）
  ↓
Prisma Client    # ORM
```

**具体改进建议：**

1. **创建服务层 (Services)**
   ```typescript
   // src/services/GroupService.ts
   export class GroupService {
     constructor(private groupRepo: GroupRepository) {}

     async createGroup(userId: string, data: CreateGroupDto) {
       // 业务逻辑
       // 验证规则
       // 事务处理
       return await this.groupRepo.create(userId, data);
     }
   }
   ```

2. **创建仓储层 (Repositories)**
   ```typescript
   // src/repositories/GroupRepository.ts
   export class GroupRepository {
     constructor(private prisma: PrismaClient) {}

     async create(userId: string, data: CreateGroupData) {
       return await this.prisma.diningGroup.create({
         data: { ...data, creatorId: userId }
       });
     }

     async findByIdWithMembers(id: string) {
       // 封装复杂查询逻辑
     }
   }
   ```

3. **创建控制器层 (Controllers)**
   ```typescript
   // src/controllers/GroupController.ts
   export class GroupController {
     constructor(private groupService: GroupService) {}

     createGroup = async (req: AuthenticatedRequest, res: Response) => {
       try {
         const validated = CreateGroupSchema.parse(req.body);
         const group = await this.groupService.createGroup(req.user.id, validated);
         res.status(201).json(group);
       } catch (error) {
         next(error); // 统一错误处理
       }
     }
   }
   ```

**优先级：高 🔥**

---

## 2. 错误处理 & 验证

### 🔴 严重问题：缺少输入验证和统一错误处理

**当前问题：**
- 没有请求体验证（任何数据都可以发送到 API）
- 没有统一的错误处理中间件
- 错误信息不一致
- 没有区分业务错误和系统错误
- 敏感信息可能泄露到错误响应中

**推荐方案：**

1. **使用 Zod 进行输入验证**
   ```typescript
   // src/validators/group.validator.ts
   import { z } from 'zod';

   export const CreateGroupSchema = z.object({
     name: z.string().min(1).max(100),
     description: z.string().max(500).optional(),
     avatarUrl: z.string().url().optional()
   });

   export type CreateGroupDto = z.infer<typeof CreateGroupSchema>;
   ```

2. **创建自定义错误类**
   ```typescript
   // src/errors/AppError.ts
   export class AppError extends Error {
     constructor(
       public statusCode: number,
       public message: string,
       public isOperational: boolean = true
     ) {
       super(message);
     }
   }

   export class NotFoundError extends AppError {
     constructor(resource: string) {
       super(404, `${resource} not found`);
     }
   }

   export class ValidationError extends AppError {
     constructor(message: string) {
       super(400, message);
     }
   }

   export class UnauthorizedError extends AppError {
     constructor(message: string = 'Unauthorized') {
       super(401, message);
     }
   }
   ```

3. **全局错误处理中间件**
   ```typescript
   // src/middleware/errorHandler.ts
   export const errorHandler = (
     err: Error,
     req: Request,
     res: Response,
     next: NextFunction
   ) => {
     if (err instanceof AppError) {
       return res.status(err.statusCode).json({
         status: 'error',
         message: err.message
       });
     }

     // Prisma 错误处理
     if (err instanceof Prisma.PrismaClientKnownRequestError) {
       // P2002: 唯一约束违反
       if (err.code === 'P2002') {
         return res.status(409).json({
           status: 'error',
           message: 'Resource already exists'
         });
       }
     }

     // 未知错误 - 不暴露详情
     console.error('Unhandled error:', err);
     res.status(500).json({
       status: 'error',
       message: 'Internal server error'
     });
   };
   ```

4. **验证中间件**
   ```typescript
   // src/middleware/validate.ts
   import { z } from 'zod';

   export const validate = (schema: z.ZodSchema) => {
     return async (req: Request, res: Response, next: NextFunction) => {
       try {
         req.body = await schema.parseAsync(req.body);
         next();
       } catch (error) {
         if (error instanceof z.ZodError) {
           return res.status(400).json({
             status: 'error',
             message: 'Validation failed',
             errors: error.errors
           });
         }
         next(error);
       }
     };
   };
   ```

**依赖安装：**
```bash
npm install zod
npm install --save-dev @types/node
```

**优先级：高 🔥**

---

## 3. 安全性改进

### 🟡 中等问题：安全措施不足

**当前问题：**
- 没有速率限制（容易被 DDoS）
- 没有请求体大小限制
- 没有 Helmet.js（缺少安全头）
- 密码强度没有验证
- JWT secret 可能不够安全
- 没有 CSRF 保护

**推荐改进：**

1. **添加速率限制**
   ```typescript
   // src/middleware/rateLimiter.ts
   import rateLimit from 'express-rate-limit';

   export const authLimiter = rateLimit({
     windowMs: 15 * 60 * 1000, // 15 分钟
     max: 5, // 限制 5 次请求
     message: 'Too many authentication attempts, please try again later'
   });

   export const apiLimiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 100 // 通用 API 限制
   });
   ```

2. **添加安全头**
   ```typescript
   import helmet from 'helmet';
   app.use(helmet());
   ```

3. **请求体大小限制**
   ```typescript
   app.use(express.json({ limit: '10mb' }));
   app.use(express.urlencoded({ extended: true, limit: '10mb' }));
   ```

4. **密码强度验证**
   ```typescript
   // src/validators/auth.validator.ts
   export const RegisterSchema = z.object({
     email: z.string().email(),
     password: z.string()
       .min(8, 'Password must be at least 8 characters')
       .regex(/[A-Z]/, 'Password must contain uppercase letter')
       .regex(/[a-z]/, 'Password must contain lowercase letter')
       .regex(/[0-9]/, 'Password must contain number')
       .regex(/[^A-Za-z0-9]/, 'Password must contain special character'),
     name: z.string().min(1).optional()
   });
   ```

5. **环境变量验证**
   ```typescript
   // src/config/env.ts
   import { z } from 'zod';

   const envSchema = z.object({
     DATABASE_URL: z.string().url(),
     JWT_SECRET: z.string().min(32),
     JWT_EXPIRY_IN_MINUTES: z.string().transform(Number).default('60'),
     PORT: z.string().transform(Number).default('3000'),
     NODE_ENV: z.enum(['development', 'production', 'test']).default('development')
   });

   export const env = envSchema.parse(process.env);
   ```

**依赖安装：**
```bash
npm install helmet express-rate-limit
npm install --save-dev @types/express-rate-limit
```

**优先级：高 🔥**

---

## 4. 数据库 & Prisma 优化

### 🟡 中等问题：查询效率和错误处理

**当前问题：**
- 没有连接池配置
- 缺少查询优化
- N+1 查询问题（某些端点）
- 没有数据库事务管理策略
- Prisma 错误没有适当处理

**推荐改进：**

1. **配置连接池**
   ```prisma
   // prisma/schema.prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
     // 连接池配置
     // DATABASE_URL="postgresql://user:pass@host:5432/db?connection_limit=10&pool_timeout=20"
   }
   ```

2. **使用事务**
   ```typescript
   // src/services/GroupService.ts
   async createGroupWithMembers(userId: string, data: CreateGroupDto) {
     return await this.prisma.$transaction(async (tx) => {
       const group = await tx.diningGroup.create({
         data: { ...data, creatorId: userId }
       });

       await tx.groupMember.create({
         data: {
           groupId: group.id,
           userId: userId,
           role: 'ADMIN',
           status: 'ACCEPTED'
         }
       });

       return group;
     });
   }
   ```

3. **优化查询（避免 N+1）**
   ```typescript
   // ❌ 不好 - N+1 问题
   const groups = await prisma.diningGroup.findMany();
   for (const group of groups) {
     group.members = await prisma.groupMember.findMany({
       where: { groupId: group.id }
     });
   }

   // ✅ 好 - 使用 include
   const groups = await prisma.diningGroup.findMany({
     include: {
       members: {
         include: { user: true }
       },
       creator: true
     }
   });
   ```

4. **添加软删除**
   ```prisma
   model DiningGroup {
     id          String    @id @default(uuid())
     name        String
     deletedAt   DateTime? // 软删除标记
     // ... 其他字段
   }
   ```

5. **添加数据库索引（已有部分，需要审查）**
   ```prisma
   model DishPost {
     // 添加组合索引用于常见查询
     @@index([groupId, createdAt])
     @@index([userId, createdAt])
     @@index([isPublic, createdAt]) // 用于社区动态
   }
   ```

**优先级：中等 🟡**

---

## 5. 配置管理

### 🟢 低优先级：配置不够结构化

**推荐改进：**

1. **创建配置模块**
   ```typescript
   // src/config/index.ts
   import { z } from 'zod';
   import dotenv from 'dotenv';

   dotenv.config();

   const configSchema = z.object({
     port: z.number().default(3000),
     nodeEnv: z.enum(['development', 'production', 'test']),
     database: z.object({
       url: z.string()
     }),
     jwt: z.object({
       secret: z.string().min(32),
       expiryMinutes: z.number().default(60),
       issuer: z.string().optional(),
       audience: z.string().optional()
     }),
     cors: z.object({
       origin: z.string().or(z.array(z.string())).default('*'),
       credentials: z.boolean().default(true)
     })
   });

   export const config = configSchema.parse({
     port: Number(process.env.PORT) || 3000,
     nodeEnv: process.env.NODE_ENV || 'development',
     database: {
       url: process.env.DATABASE_URL
     },
     jwt: {
       secret: process.env.JWT_SECRET,
       expiryMinutes: Number(process.env.JWT_EXPIRY_IN_MINUTES) || 60,
       issuer: process.env.JWT_ISSUER,
       audience: process.env.JWT_AUDIENCE
     },
     cors: {
       origin: process.env.CORS_ORIGIN || '*',
       credentials: true
     }
   });
   ```

**优先级：低 🟢**

---

## 6. 日志 & 监控

### 🟡 中等问题：缺少日志系统

**当前问题：**
- 只有 console.log
- 没有日志级别
- 没有结构化日志
- 无法追踪请求链路
- 生产环境调试困难

**推荐方案：**

1. **使用 Winston 或 Pino**
   ```typescript
   // src/utils/logger.ts
   import winston from 'winston';

   export const logger = winston.createLogger({
     level: process.env.LOG_LEVEL || 'info',
     format: winston.format.combine(
       winston.format.timestamp(),
       winston.format.errors({ stack: true }),
       winston.format.json()
     ),
     transports: [
       new winston.transports.File({ filename: 'error.log', level: 'error' }),
       new winston.transports.File({ filename: 'combined.log' }),
       new winston.transports.Console({
         format: winston.format.simple()
       })
     ]
   });
   ```

2. **请求日志中间件**
   ```typescript
   // src/middleware/requestLogger.ts
   import morgan from 'morgan';

   export const requestLogger = morgan('combined', {
     stream: {
       write: (message) => logger.info(message.trim())
     }
   });
   ```

3. **添加请求 ID 追踪**
   ```typescript
   import { v4 as uuidv4 } from 'uuid';

   app.use((req, res, next) => {
     req.id = uuidv4();
     res.setHeader('X-Request-ID', req.id);
     next();
   });
   ```

**依赖安装：**
```bash
npm install winston morgan uuid
npm install --save-dev @types/morgan @types/uuid
```

**优先级：中等 🟡**

---

## 7. 测试策略

### 🔴 严重问题：完全没有测试

**推荐方案：**

1. **测试框架设置**
   ```bash
   npm install --save-dev jest @types/jest ts-jest supertest @types/supertest
   npm install --save-dev @faker-js/faker
   ```

2. **Jest 配置**
   ```javascript
   // jest.config.js
   module.exports = {
     preset: 'ts-jest',
     testEnvironment: 'node',
     roots: ['<rootDir>/src'],
     testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts'],
     collectCoverageFrom: [
       'src/**/*.ts',
       '!src/**/*.d.ts',
       '!src/**/*.interface.ts'
     ],
     coverageThreshold: {
       global: {
         branches: 70,
         functions: 70,
         lines: 70,
         statements: 70
       }
     }
   };
   ```

3. **测试结构**
   ```
   src/
   ├── services/
   │   ├── GroupService.ts
   │   └── __tests__/
   │       └── GroupService.test.ts
   ├── repositories/
   │   ├── GroupRepository.ts
   │   └── __tests__/
   │       └── GroupRepository.test.ts
   └── __tests__/
       ├── integration/
       │   └── group.routes.test.ts
       └── setup.ts
   ```

4. **测试示例**
   ```typescript
   // src/services/__tests__/GroupService.test.ts
   describe('GroupService', () => {
     let service: GroupService;
     let mockRepo: jest.Mocked<GroupRepository>;

     beforeEach(() => {
       mockRepo = createMockRepository();
       service = new GroupService(mockRepo);
     });

     describe('createGroup', () => {
       it('should create a group with admin member', async () => {
         const userId = 'user-123';
         const data = { name: 'Test Group' };

         mockRepo.create.mockResolvedValue(mockGroup);

         const result = await service.createGroup(userId, data);

         expect(result.name).toBe('Test Group');
         expect(mockRepo.create).toHaveBeenCalledWith(userId, data);
       });
     });
   });
   ```

**优先级：高 🔥**

---

## 8. API 设计改进

### 🟡 中等问题：API 设计不一致

**当前问题：**
- 响应格式不统一
- 缺少分页
- 没有 API 版本控制
- 缺少 HATEOAS 链接
- 错误响应格式不一致

**推荐改进：**

1. **统一响应格式**
   ```typescript
   // src/types/ApiResponse.ts
   export interface ApiResponse<T> {
     status: 'success' | 'error';
     data?: T;
     message?: string;
     meta?: {
       page?: number;
       limit?: number;
       total?: number;
       timestamp: string;
       requestId: string;
     };
   }

   // 响应帮助函数
   export const successResponse = <T>(
     data: T,
     message?: string,
     meta?: any
   ): ApiResponse<T> => ({
     status: 'success',
     data,
     message,
     meta: {
       ...meta,
       timestamp: new Date().toISOString()
     }
   });
   ```

2. **分页工具**
   ```typescript
   // src/utils/pagination.ts
   export interface PaginationParams {
     page: number;
     limit: number;
   }

   export const paginate = (page: number = 1, limit: number = 20) => ({
     skip: (page - 1) * limit,
     take: limit
   });

   export const paginationMeta = (
     total: number,
     page: number,
     limit: number
   ) => ({
     page,
     limit,
     total,
     totalPages: Math.ceil(total / limit),
     hasNextPage: page * limit < total,
     hasPreviousPage: page > 1
   });
   ```

3. **API 版本控制**
   ```typescript
   // src/index.ts
   app.use('/api/v1/auth', authRoutes);
   app.use('/api/v1/groups', groupRoutes);
   // 未来可以添加 v2
   ```

**优先级：中等 🟡**

---

## 9. 性能优化

### 🟢 低优先级：缺少缓存策略

**推荐改进：**

1. **Redis 缓存层**
   ```typescript
   // src/cache/RedisClient.ts
   import { Redis } from 'ioredis';

   export class CacheService {
     private client: Redis;

     constructor() {
       this.client = new Redis(process.env.REDIS_URL);
     }

     async get<T>(key: string): Promise<T | null> {
       const data = await this.client.get(key);
       return data ? JSON.parse(data) : null;
     }

     async set(key: string, value: any, ttlSeconds: number = 3600) {
       await this.client.setex(key, ttlSeconds, JSON.stringify(value));
     }

     async del(key: string) {
       await this.client.del(key);
     }
   }
   ```

2. **缓存中间件**
   ```typescript
   // 缓存用户信息
   async getUserById(userId: string) {
     const cacheKey = `user:${userId}`;
     const cached = await cache.get(cacheKey);

     if (cached) return cached;

     const user = await prisma.user.findUnique({ where: { id: userId } });
     if (user) {
       await cache.set(cacheKey, user, 600); // 10 分钟
     }

     return user;
   }
   ```

**依赖安装：**
```bash
npm install ioredis
npm install --save-dev @types/ioredis
```

**优先级：低 🟢（可以在用户量增长后再考虑）**

---

## 10. 文档 & 开发体验

### 🟡 中等问题：API 文档缺失

**推荐改进：**

1. **Swagger/OpenAPI 文档**
   ```typescript
   import swaggerJsDoc from 'swagger-jsdoc';
   import swaggerUi from 'swagger-ui-express';

   const swaggerOptions = {
     definition: {
       openapi: '3.0.0',
       info: {
         title: 'GroupEat API',
         version: '1.0.0',
         description: 'API for GroupEat social dining app'
       },
       servers: [{ url: '/api/v1' }],
       components: {
         securitySchemes: {
           bearerAuth: {
             type: 'http',
             scheme: 'bearer',
             bearerFormat: 'JWT'
           }
         }
       }
     },
     apis: ['./src/routes/*.ts']
   };

   const swaggerSpec = swaggerJsDoc(swaggerOptions);
   app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
   ```

2. **JSDoc 注释**
   ```typescript
   /**
    * @swagger
    * /groups:
    *   post:
    *     summary: Create a new dining group
    *     tags: [Groups]
    *     security:
    *       - bearerAuth: []
    *     requestBody:
    *       required: true
    *       content:
    *         application/json:
    *           schema:
    *             type: object
    *             required:
    *               - name
    *             properties:
    *               name:
    *                 type: string
    *               description:
    *                 type: string
    */
   ```

**依赖安装：**
```bash
npm install swagger-jsdoc swagger-ui-express
npm install --save-dev @types/swagger-jsdoc @types/swagger-ui-express
```

**优先级：中等 🟡**

---

## 11. 前端架构规划

### 🟡 中等问题：前端还未开始

**推荐技术栈：**
- **框架：** React Native + Expo
- **导航：** React Navigation
- **状态管理：** Zustand 或 React Query
- **样式：** NativeWind (Tailwind for React Native)
- **表单：** React Hook Form + Zod
- **HTTP 客户端：** Axios with interceptors

**推荐目录结构：**
```
groupeat-frontend/
├── src/
│   ├── api/              # API 客户端
│   │   ├── client.ts     # Axios 配置
│   │   └── endpoints/    # API 端点定义
│   ├── components/       # 可复用组件
│   │   ├── common/       # 通用组件
│   │   └── features/     # 功能组件
│   ├── screens/          # 页面
│   │   ├── auth/
│   │   ├── groups/
│   │   └── feed/
│   ├── navigation/       # 导航配置
│   ├── store/            # 状态管理
│   ├── hooks/            # 自定义 hooks
│   ├── utils/            # 工具函数
│   ├── types/            # TypeScript 类型
│   └── constants/        # 常量
├── assets/               # 静态资源
└── app.json              # Expo 配置
```

**优先级：中等 🟡（需要尽快开始）**

---

## 12. DevOps & 部署

### 🟢 低优先级：生产环境准备

**推荐改进：**

1. **Docker 化**
   ```dockerfile
   # Dockerfile
   FROM node:18-alpine
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --only=production
   COPY . .
   RUN npm run build
   EXPOSE 3000
   CMD ["npm", "start"]
   ```

2. **Docker Compose（本地开发）**
   ```yaml
   # docker-compose.yml
   version: '3.8'
   services:
     app:
       build: .
       ports:
         - "3000:3000"
       environment:
         DATABASE_URL: postgresql://postgres:password@db:5432/groupeat
         JWT_SECRET: ${JWT_SECRET}
       depends_on:
         - db
         - redis

     db:
       image: postgres:15
       environment:
         POSTGRES_DB: groupeat
         POSTGRES_PASSWORD: password
       volumes:
         - postgres_data:/var/lib/postgresql/data

     redis:
       image: redis:7-alpine
       ports:
         - "6379:6379"

   volumes:
     postgres_data:
   ```

3. **健康检查端点**
   ```typescript
   app.get('/health', async (req, res) => {
     try {
       await prisma.$queryRaw`SELECT 1`;
       res.json({
         status: 'ok',
         timestamp: new Date().toISOString(),
         uptime: process.uptime()
       });
     } catch (error) {
       res.status(503).json({ status: 'error', message: 'Database unavailable' });
     }
   });
   ```

4. **CI/CD Pipeline（GitHub Actions）**
   ```yaml
   # .github/workflows/ci.yml
   name: CI
   on: [push, pull_request]
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v3
         - uses: actions/setup-node@v3
           with:
             node-version: 18
         - run: npm ci
         - run: npm run lint
         - run: npm test
         - run: npm run build
   ```

**优先级：低 🟢**

---

## 实施优先级总结

### 🔥 立即实施（高优先级）

1. **分层架构重构** - 创建 Services + Repositories + Controllers
2. **输入验证** - 集成 Zod
3. **错误处理** - 统一错误处理中间件
4. **安全加固** - Helmet, 速率限制, 密码验证
5. **测试基础设施** - Jest + 单元测试

**预计时间：2-3 周**

### 🟡 短期实施（中等优先级）

6. **日志系统** - Winston + 请求追踪
7. **API 文档** - Swagger
8. **数据库优化** - 事务, 查询优化
9. **前端开发** - 开始 React Native 应用

**预计时间：3-4 周**

### 🟢 长期规划（低优先级）

10. **缓存层** - Redis
11. **配置管理重构**
12. **Docker + CI/CD**
13. **监控和告警**

**预计时间：按需实施**

---

## 技术债务清单

| 问题 | 影响 | 工作量 | ROI |
|-----|------|--------|-----|
| 缺少分层架构 | 高 | 大 | 高 |
| 没有输入验证 | 高 | 中 | 高 |
| 没有测试 | 高 | 大 | 高 |
| 安全措施不足 | 高 | 小 | 高 |
| 没有日志系统 | 中 | 小 | 中 |
| 缺少 API 文档 | 中 | 小 | 中 |
| 没有缓存 | 低 | 中 | 低 |
| 没有 CI/CD | 低 | 中 | 中 |

---

## 推荐依赖包清单

```json
{
  "dependencies": {
    "helmet": "^8.0.0",
    "express-rate-limit": "^7.5.0",
    "zod": "^3.24.1",
    "winston": "^3.17.0",
    "morgan": "^1.10.0",
    "ioredis": "^5.4.2",
    "swagger-jsdoc": "^6.2.8",
    "swagger-ui-express": "^5.0.1"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "@types/jest": "^29.5.14",
    "ts-jest": "^29.2.6",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.2",
    "@faker-js/faker": "^9.4.0",
    "eslint": "^9.20.0",
    "prettier": "^3.5.2"
  }
}
```

---

## 结论

GroupEat 的核心功能已经实现，但代码质量、安全性和可维护性需要显著提升。通过实施分层架构、添加验证和错误处理、建立测试基础设施以及加强安全措施，可以将代码库提升到生产就绪状态。

建议按照上述优先级逐步实施改进，首先关注高优先级项目（架构、验证、安全、测试），然后再处理日志、文档和性能优化等中低优先级任务。

---

**审查日期：** 2025-10-30
**审查者：** Claude (AI Code Reviewer)
**代码库版本：** claude/code-review-architecture-011CUdyBevB2HjfFUNZ7hCEA
