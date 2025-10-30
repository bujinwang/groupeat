# GroupEat 功能需求与开发路线图

## 📊 当前实现状态总览

### ✅ 已完成功能（Backend）
- [x] 用户认证系统（注册、登录、JWT）
- [x] 群组管理（创建、查询、更新、删除）
- [x] 成员管理（添加、删除、角色管理）
- [x] 邀请系统（Token 生成、接受邀请）
- [x] 用户偏好设置（口味、饮食限制、价格偏好）
- [x] 菜品发布（创建、群组动态、社区动态）
- [x] 餐厅详情（基本信息、评价、关联菜品）
- [x] 数据库设计和迁移

### 🟡 部分完成（需要增强）
- [ ] AI 推荐系统（占位符存在，需要真实 AI 集成）
- [ ] 菜品社交功能（点赞/评论端点未实现）
- [ ] 图片处理（接受 URL，但缺少上传服务）
- [ ] 餐厅搜索（仅有详情端点）

### ❌ 完全缺失
- [ ] 整个前端应用（React Native）
- [ ] 投票/决策系统
- [ ] 实时通知
- [ ] SMS/Email 发送服务
- [ ] 测试套件
- [ ] 生产部署

---

## 🎯 功能需求详细清单

### 1. 🔐 认证与用户管理

#### 已实现 ✅
- 用户注册（邮箱 + 密码）
- 用户登录（JWT 返回）
- 密码哈希（bcrypt）
- 路由保护中间件

#### 需要补充 ⚠️
- [ ] **密码重置功能**
  - 发送重置邮件
  - 重置 Token 验证
  - 设置新密码
  - API: `POST /auth/forgot-password`, `POST /auth/reset-password`

- [ ] **邮箱验证**
  - 注册后发送验证邮件
  - 邮箱验证 Token
  - 未验证用户功能限制
  - API: `POST /auth/verify-email`, `POST /auth/resend-verification`

- [ ] **社交登录（可选，长期）**
  - Google OAuth
  - Apple Sign-In
  - API: `POST /auth/google`, `POST /auth/apple`

- [ ] **用户资料管理**
  - 更新个人信息（头像、姓名、简介）
  - 隐私设置
  - API: `PUT /users/me`, `PUT /users/me/avatar`

- [ ] **账户安全**
  - 修改密码（需要当前密码验证）
  - 注销所有设备（撤销所有 Token）
  - API: `PUT /users/me/password`, `POST /auth/logout-all`

---

### 2. 👥 群组功能

#### 已实现 ✅
- 创建群组
- 查询用户的所有群组
- 查询单个群组详情
- 更新群组信息（仅管理员）
- 删除群组（仅管理员）

#### 需要补充 ⚠️
- [ ] **群组设置增强**
  - 群组隐私设置（公开/私密）
  - 群组标签/分类（家人、朋友、同事）
  - 群组封面图片上传
  - 群组描述富文本支持
  - API: `PUT /groups/:groupId/settings`

- [ ] **群组活动历史**
  - 聚餐历史记录
  - 决策历史
  - 餐厅打卡记录
  - API: `GET /groups/:groupId/activities`

- [ ] **群组统计**
  - 成员活跃度
  - 最常去的餐厅
  - 口味偏好分析
  - API: `GET /groups/:groupId/statistics`

- [ ] **群组搜索与发现（可选，长期）**
  - 搜索公开群组
  - 加入公开群组
  - API: `GET /groups/discover`, `POST /groups/:groupId/join`

---

### 3. 👤 成员管理

#### 已实现 ✅
- 添加成员（直接添加或邀请）
- 删除成员（管理员权限）
- 更新成员角色（ADMIN/MEMBER）
- 防止删除最后一个管理员

#### 需要补充 ⚠️
- [ ] **成员权限细化**
  - 自定义角色（例如：投票权、发帖权）
  - 权限模板
  - API: `PUT /groups/:groupId/members/:userId/permissions`

- [ ] **成员管理增强**
  - 禁言功能
  - 临时成员（有过期时间）
  - 成员备注（给成员添加标签）
  - API: `PUT /groups/:groupId/members/:userId/mute`

- [ ] **成员查询优化**
  - 按角色筛选成员
  - 按活跃度排序
  - API: `GET /groups/:groupId/members?role=ADMIN&sort=activity`

---

### 4. 📧 邀请系统

#### 已实现 ✅
- 生成邀请 Token（7 天过期）
- 通过 Token 接受邀请
- 记录邀请人和被邀请人
- 邀请状态追踪（PENDING, ACCEPTED, EXPIRED, DECLINED）

#### 需要补充 ⚠️
- [ ] **短信邀请集成** 🔥 高优先级
  - 集成 Twilio 或其他 SMS 服务
  - 发送带邀请链接的短信
  - 短信模板管理
  - API: `POST /invitations/send-sms`

- [ ] **邮件邀请集成** 🔥 高优先级
  - 集成 SendGrid 或 AWS SES
  - 发送带邀请链接的邮件
  - 邮件模板（HTML）
  - API: `POST /invitations/send-email`

- [ ] **二维码邀请** 🔥 高优先级
  - 生成群组邀请二维码
  - 扫码加入群组
  - 前端需要 QR 码扫描功能
  - API: `GET /invitations/:token/qrcode`

- [ ] **邀请管理**
  - 撤销邀请（已发送但未接受）
  - 查看群组所有邀请记录
  - 重新发送邀请
  - API: `DELETE /invitations/:id`, `GET /groups/:groupId/invitations`, `POST /invitations/:id/resend`

- [ ] **批量邀请**
  - 同时邀请多个联系人
  - CSV 导入联系人
  - API: `POST /invitations/batch`

---

### 5. 🍽️ 餐厅功能

#### 已实现 ✅
- 获取单个餐厅详情（含评价和菜品）
- 餐厅基本信息（名称、地址、经纬度）
- 餐厅与 Google Places 集成（字段存在）

#### 需要补充 ⚠️
- [ ] **餐厅搜索与列表** 🔥 高优先级
  - 按名称搜索餐厅
  - 按位置搜索（附近餐厅）
  - 按菜系筛选
  - 按价格区间筛选
  - 按评分排序
  - 分页支持
  - API: `GET /restaurants?q=sushi&lat=37.7&lng=-122.4&cuisine=Japanese&priceRange=2-3&sort=rating&page=1`

- [ ] **餐厅数据源集成** 🔥 高优先级
  - Google Places API 集成
  - Yelp API 集成（可选）
  - 自动导入餐厅数据
  - 定期更新餐厅信息
  - API: `POST /restaurants/import` (管理后台)

- [ ] **餐厅创建与管理**
  - 用户建议新餐厅（需要审核）
  - 管理员添加/编辑餐厅
  - 餐厅认领（餐厅老板）
  - API: `POST /restaurants`, `PUT /restaurants/:id`, `POST /restaurants/:id/claim`

- [ ] **餐厅详情增强**
  - 营业时间
  - 菜单/价格信息
  - 环境照片
  - 特色菜推荐
  - 停车信息
  - API: `GET /restaurants/:id/menu`, `PUT /restaurants/:id/hours`

- [ ] **餐厅收藏**
  - 用户收藏餐厅
  - 查看收藏列表
  - API: `POST /users/me/favorites`, `GET /users/me/favorites`

---

### 6. ⭐ 评价系统

#### 已实现 ✅
- 用户对餐厅评价（1-5 星 + 评论）
- 每个用户每个餐厅只能评价一次
- 餐厅详情中显示评价

#### 需要补充 ⚠️
- [ ] **评价功能增强**
  - 评价图片上传
  - 评价点赞/踩
  - 评价举报（不当内容）
  - 评价编辑与删除
  - API: `PUT /reviews/:id`, `DELETE /reviews/:id`, `POST /reviews/:id/like`, `POST /reviews/:id/report`

- [ ] **评价筛选与排序**
  - 按评分筛选
  - 按时间排序
  - 按点赞数排序
  - API: `GET /restaurants/:id/reviews?minRating=4&sort=likes`

- [ ] **评价统计**
  - 评分分布（几星的有多少）
  - 关键词提取（好评/差评关键词）
  - API: `GET /restaurants/:id/reviews/statistics`

---

### 7. 📸 菜品发布（社交功能）

#### 已实现 ✅
- 创建菜品发布（照片、标题、评分）
- 群组内动态
- 社区公开动态
- 匿名发布选项
- 关联餐厅

#### 需要补充 ⚠️
- [ ] **点赞功能** 🔥 高优先级
  - 点赞/取消点赞
  - 查看点赞用户列表
  - 点赞数统计
  - API: `POST /posts/:id/like`, `DELETE /posts/:id/like`, `GET /posts/:id/likes`

- [ ] **评论功能** 🔥 高优先级
  - 发表评论
  - 删除评论（作者或管理员）
  - 评论分页
  - 评论点赞
  - 评论回复（嵌套评论）
  - API: `POST /posts/:id/comments`, `DELETE /comments/:id`, `GET /posts/:id/comments`, `POST /comments/:id/like`

- [ ] **菜品发布管理**
  - 编辑发布内容
  - 删除发布
  - 查看个人发布历史
  - API: `PUT /posts/:id`, `DELETE /posts/:id`, `GET /users/:id/posts`

- [ ] **动态 Feed 增强**
  - 个性化推荐（基于用户喜好）
  - 按餐厅筛选动态
  - 按菜系筛选动态
  - 热门动态（高赞/高评论）
  - API: `GET /posts/trending`, `GET /posts?restaurantId=xxx&cuisine=Japanese`

- [ ] **图片上传服务** 🔥 高优先级
  - 集成 AWS S3 或 Cloudinary
  - 图片压缩和优化
  - 图片 CDN
  - 图片审核（防止不当内容）
  - API: `POST /upload/image` (返回 URL)

- [ ] **内容审核**
  - 举报不当内容
  - 管理员审核队列
  - 自动内容过滤
  - API: `POST /posts/:id/report`, `GET /admin/reports` (管理后台)

---

### 8. 🤖 AI 推荐系统

#### 已实现 ✅
- 基础推荐端点（占位符）
- 聚合群组成员偏好
- 简单规则过滤

#### 需要补充 ⚠️
- [ ] **AI 模型集成** 🔥 高优先级
  - 集成 OpenAI GPT-4 或 Claude
  - Prompt 工程优化
  - 考虑因素：
    - 群组成员口味偏好
    - 饮食限制
    - 价格偏好
    - 历史聚餐记录
    - 社区热门餐厅
    - 地理位置
    - 时间（午餐/晚餐）
  - API: `POST /groups/:groupId/recommendations` (增强现有端点)

- [ ] **推荐算法优化**
  - 协同过滤（基于相似群组）
  - 内容过滤（基于餐厅特征）
  - 混合推荐
  - 推荐解释（为什么推荐这家）
  - API: 同上，增强响应格式

- [ ] **推荐上下文**
  - 支持特定场景（生日聚会、商务宴请、朋友聚会）
  - 时间偏好（午餐/晚餐）
  - 距离限制
  - API: `POST /groups/:groupId/recommendations?occasion=birthday&time=dinner&maxDistance=5km`

- [ ] **推荐历史**
  - 记录推荐结果
  - 追踪用户是否采纳
  - 反馈循环（提高推荐质量）
  - API: `GET /groups/:groupId/recommendations/history`

---

### 9. 🗳️ 投票与决策系统

#### 当前状态 ❌ 完全缺失

这是 **关键功能**，需要从头实现。

#### 需要实现 🔥 高优先级

**数据库模型：**
```prisma
model VotingSession {
  id          String   @id @default(uuid())
  groupId     String
  creatorId   String
  title       String?  // "周五去哪吃？"
  description String?
  status      VotingStatus  @default(ACTIVE) // ACTIVE, CLOSED
  votingType  VotingType    // SINGLE_CHOICE, MULTIPLE_CHOICE, RANKED
  allowAddOptions Boolean   @default(true)  // 成员能否添加选项
  deadline    DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  group       DiningGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  creator     User        @relation(fields: [creatorId], references: [id])
  options     VotingOption[]
  votes       Vote[]

  @@index([groupId])
  @@index([status])
}

model VotingOption {
  id          String   @id @default(uuid())
  sessionId   String
  restaurantId String?
  customName  String?  // 如果不是餐厅选项
  description String?
  addedBy     String   // 添加此选项的用户
  createdAt   DateTime @default(now())

  session     VotingSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  restaurant  Restaurant?   @relation(fields: [restaurantId], references: [id])
  adder       User          @relation(fields: [addedBy], references: [id])
  votes       Vote[]

  @@index([sessionId])
}

model Vote {
  id        String   @id @default(uuid())
  sessionId String
  optionId  String
  userId    String
  rank      Int?     // 用于排序投票
  comment   String?  // 投票备注
  createdAt DateTime @default(now())

  session   VotingSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  option    VotingOption  @relation(fields: [optionId], references: [id], onDelete: Cascade)
  user      User          @relation(fields: [userId], references: [id])

  @@unique([sessionId, userId, optionId]) // 每个用户每个选项只能投一次
  @@index([sessionId])
  @@index([userId])
}

enum VotingStatus {
  ACTIVE
  CLOSED
}

enum VotingType {
  SINGLE_CHOICE    // 单选
  MULTIPLE_CHOICE  // 多选
  RANKED           // 排序投票
}
```

**API 端点：**
- [ ] `POST /groups/:groupId/voting` - 创建投票会话
- [ ] `GET /groups/:groupId/voting` - 获取群组所有投票会话
- [ ] `GET /voting/:sessionId` - 获取投票详情
- [ ] `PUT /voting/:sessionId` - 更新投票设置（创建者）
- [ ] `POST /voting/:sessionId/close` - 关闭投票
- [ ] `DELETE /voting/:sessionId` - 删除投票

- [ ] `POST /voting/:sessionId/options` - 添加投票选项
- [ ] `DELETE /voting/options/:optionId` - 删除选项

- [ ] `POST /voting/:sessionId/vote` - 投票
- [ ] `PUT /votes/:voteId` - 修改投票
- [ ] `DELETE /votes/:voteId` - 撤销投票
- [ ] `GET /voting/:sessionId/results` - 获取投票结果

**功能特性：**
- 实时投票更新（可考虑 WebSocket）
- 投票截止时间
- 匿名投票选项
- 投票结果可视化数据
- 自动选出赢家（最高票）
- 投票提醒通知

---

### 10. 📍 地理位置与导航

#### 当前状态 🟡 部分实现
- 餐厅有经纬度字段

#### 需要补充 ⚠️
- [ ] **地图集成** 🔥 高优先级
  - 在地图上显示餐厅位置
  - 显示群组成员当前位置
  - 计算到餐厅的距离
  - 前端：集成 Google Maps 或 Apple Maps
  - API: 提供地理数据即可，前端处理显示

- [ ] **导航功能**
  - 打开外部地图应用导航
  - 显示路线和预计时间
  - 前端：Deep link 到地图应用

- [ ] **附近功能**
  - 查找附近餐厅
  - 基于位置推荐
  - API: `GET /restaurants/nearby?lat=xxx&lng=xxx&radius=5km`

---

### 11. 🔔 通知系统

#### 当前状态 ❌ 完全缺失

#### 需要实现 🔥 高优先级

**数据库模型：**
```prisma
model Notification {
  id        String   @id @default(uuid())
  userId    String
  type      NotificationType
  title     String
  message   String
  data      Json?    // 额外数据（如相关 ID）
  isRead    Boolean  @default(false)
  createdAt DateTime @default(now())

  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, isRead])
  @@index([createdAt])
}

enum NotificationType {
  GROUP_INVITATION
  MEMBER_JOINED
  MEMBER_LEFT
  NEW_POST
  POST_LIKED
  POST_COMMENTED
  VOTING_STARTED
  VOTING_REMINDER
  VOTING_CLOSED
  RECOMMENDATION_READY
  MENTION
}
```

**API 端点：**
- [ ] `GET /notifications` - 获取用户通知列表
- [ ] `PUT /notifications/:id/read` - 标记为已读
- [ ] `PUT /notifications/read-all` - 全部标记为已读
- [ ] `DELETE /notifications/:id` - 删除通知
- [ ] `GET /notifications/unread-count` - 未读数量

**通知触发时机：**
- 收到群组邀请
- 有人加入/离开群组
- 群组内新发布
- 发布被点赞/评论
- 被 @ 提及
- 投票开始/即将截止
- AI 推荐准备好
- 系统公告

**推送通知（前端）：**
- [ ] 集成 Expo Push Notifications
- [ ] 用户可配置通知偏好
- [ ] 后端发送推送到设备

---

### 12. 💬 实时聊天（可选，长期）

#### 当前状态 ❌ 完全缺失

#### 需要考虑 🟢 低优先级

**技术选型：**
- WebSocket (Socket.io)
- 或使用第三方服务（Sendbird, Stream Chat）

**功能：**
- [ ] 群组聊天
- [ ] 私聊
- [ ] 消息历史
- [ ] 图片/表情发送
- [ ] 消息提醒

**数据库模型：**
```prisma
model Message {
  id        String   @id @default(uuid())
  groupId   String?  // 群聊
  senderId  String
  receiverId String? // 私聊
  content   String
  type      MessageType @default(TEXT)
  createdAt DateTime @default(now())

  group     DiningGroup? @relation(fields: [groupId], references: [id])
  sender    User         @relation("SentMessages", fields: [senderId], references: [id])
  receiver  User?        @relation("ReceivedMessages", fields: [receiverId], references: [id])

  @@index([groupId, createdAt])
  @@index([senderId, receiverId])
}

enum MessageType {
  TEXT
  IMAGE
  LOCATION
  RESTAURANT_SHARE
}
```

---

### 13. 📱 前端应用（React Native + Expo）

#### 当前状态 ❌ 完全缺失

这是 **最大的缺失部分**。需要从头构建整个移动应用。

#### 需要实现 🔥 最高优先级

**技术栈建议：**
- React Native + Expo
- React Navigation（导航）
- React Query（数据获取与缓存）
- Zustand（轻量状态管理）
- React Hook Form + Zod（表单验证）
- NativeWind（样式，Tailwind for RN）
- Axios（HTTP 客户端）

**核心页面与功能：**

##### 认证流程
- [ ] 启动页 (Splash Screen)
- [ ] 登录页
- [ ] 注册页
- [ ] 忘记密码流程
- [ ] 邮箱验证提示

##### 主界面导航
- [ ] Tab 导航结构（首页、群组、动态、个人）
- [ ] 侧边栏/抽屉导航（可选）

##### 首页 (Home)
- [ ] 推荐餐厅卡片
- [ ] 快速创建投票入口
- [ ] 即将到来的聚餐
- [ ] 附近热门餐厅

##### 群组模块
- [ ] 群组列表（我加入的群组）
- [ ] 创建群组
- [ ] 群组详情页
  - 成员列表
  - 群组设置
  - 邀请成员（联系人、二维码、链接）
  - 群组动态
  - 聚餐历史
- [ ] 群组管理（管理员）
  - 编辑群组信息
  - 管理成员
  - 删除群组

##### 推荐与投票
- [ ] AI 推荐页面
  - 输入偏好和约束
  - 显示推荐结果
  - 一键创建投票
- [ ] 投票页面
  - 创建投票
  - 投票列表
  - 投票详情与投票
  - 实时结果展示

##### 餐厅模块
- [ ] 餐厅搜索页
  - 搜索框
  - 筛选器（菜系、价格、距离）
  - 地图视图 / 列表视图
- [ ] 餐厅详情页
  - 基本信息
  - 地图位置
  - 评价列表
  - 菜品照片
  - 导航按钮
  - 收藏按钮
- [ ] 发表评价

##### 社区动态
- [ ] 社区 Feed（瀑布流）
- [ ] 发布菜品
  - 选择照片（相机/相册）
  - 选择餐厅
  - 填写标题和评分
  - 选择分享到的群组
- [ ] 动态详情
  - 查看大图
  - 点赞
  - 评论列表
  - 发表评论

##### 个人中心
- [ ] 个人资料
  - 头像上传
  - 编辑信息
  - 口味偏好设置
- [ ] 我的发布
- [ ] 我的收藏
- [ ] 我的评价
- [ ] 通知中心
- [ ] 设置
  - 账户安全
  - 隐私设置
  - 通知偏好
  - 关于

##### 其他功能
- [ ] 联系人集成（expo-contacts）
- [ ] 相机/相册访问
- [ ] 二维码扫描
- [ ] 地图集成
- [ ] 推送通知
- [ ] 深度链接（邀请链接）
- [ ] 分享功能（分享餐厅、发布）
- [ ] 下拉刷新 / 上拉加载更多
- [ ] 骨架屏加载状态
- [ ] 错误处理与提示
- [ ] 离线支持（可选）

**前端项目结构：**
```
groupeat-frontend/
├── app.json                 # Expo 配置
├── package.json
├── tsconfig.json
├── App.tsx                  # 应用入口
├── src/
│   ├── api/                 # API 客户端
│   │   ├── client.ts        # Axios 配置（拦截器、Token）
│   │   ├── auth.api.ts
│   │   ├── groups.api.ts
│   │   ├── posts.api.ts
│   │   ├── restaurants.api.ts
│   │   └── voting.api.ts
│   ├── components/          # 可复用组件
│   │   ├── common/          # 通用组件
│   │   │   ├── Button.tsx
│   │   │   ├── Input.tsx
│   │   │   ├── Card.tsx
│   │   │   ├── Avatar.tsx
│   │   │   └── Loading.tsx
│   │   └── features/        # 功能组件
│   │       ├── GroupCard.tsx
│   │       ├── RestaurantCard.tsx
│   │       ├── PostCard.tsx
│   │       └── VotingCard.tsx
│   ├── screens/             # 页面/屏幕
│   │   ├── auth/
│   │   │   ├── LoginScreen.tsx
│   │   │   ├── RegisterScreen.tsx
│   │   │   └── ForgotPasswordScreen.tsx
│   │   ├── home/
│   │   │   └── HomeScreen.tsx
│   │   ├── groups/
│   │   │   ├── GroupListScreen.tsx
│   │   │   ├── GroupDetailScreen.tsx
│   │   │   ├── CreateGroupScreen.tsx
│   │   │   └── InviteMembersScreen.tsx
│   │   ├── restaurants/
│   │   │   ├── RestaurantSearchScreen.tsx
│   │   │   ├── RestaurantDetailScreen.tsx
│   │   │   └── RestaurantMapScreen.tsx
│   │   ├── feed/
│   │   │   ├── FeedScreen.tsx
│   │   │   ├── CreatePostScreen.tsx
│   │   │   └── PostDetailScreen.tsx
│   │   ├── voting/
│   │   │   ├── VotingListScreen.tsx
│   │   │   ├── CreateVotingScreen.tsx
│   │   │   └── VotingDetailScreen.tsx
│   │   └── profile/
│   │       ├── ProfileScreen.tsx
│   │       ├── EditProfileScreen.tsx
│   │       ├── PreferencesScreen.tsx
│   │       └── SettingsScreen.tsx
│   ├── navigation/          # 导航配置
│   │   ├── RootNavigator.tsx
│   │   ├── AuthNavigator.tsx
│   │   └── MainTabNavigator.tsx
│   ├── store/               # 状态管理
│   │   ├── authStore.ts
│   │   ├── userStore.ts
│   │   └── notificationStore.ts
│   ├── hooks/               # 自定义 Hooks
│   │   ├── useAuth.ts
│   │   ├── useGroups.ts
│   │   ├── useRestaurants.ts
│   │   └── useInfiniteScroll.ts
│   ├── utils/               # 工具函数
│   │   ├── storage.ts       # AsyncStorage 封装
│   │   ├── validation.ts    # Zod schemas
│   │   ├── formatters.ts    # 日期、距离格式化
│   │   └── permissions.ts   # 相机、位置权限
│   ├── types/               # TypeScript 类型
│   │   ├── api.types.ts
│   │   ├── models.types.ts
│   │   └── navigation.types.ts
│   ├── constants/           # 常量
│   │   ├── theme.ts
│   │   ├── config.ts
│   │   └── cuisines.ts
│   └── assets/              # 静态资源
│       ├── images/
│       ├── icons/
│       └── fonts/
└── __tests__/               # 测试
```

---

### 14. 🧪 测试

#### 当前状态 ❌ 完全缺失

#### 需要实现 🔥 高优先级

**后端测试：**
- [ ] 单元测试（Services, Repositories）
- [ ] 集成测试（API 端点）
- [ ] E2E 测试（完整流程）
- [ ] 测试覆盖率 > 70%

**前端测试：**
- [ ] 组件测试（React Native Testing Library）
- [ ] Hook 测试
- [ ] 导航测试
- [ ] API Mock 测试

**测试框架：**
- Backend: Jest + Supertest
- Frontend: Jest + React Native Testing Library

---

### 15. 📊 管理后台（可选，长期）

#### 当前状态 ❌ 不存在

#### 可以考虑 🟢 低优先级

**功能：**
- [ ] 用户管理（查看、禁用用户）
- [ ] 餐厅管理（添加、编辑、删除）
- [ ] 内容审核（举报处理）
- [ ] 数据统计（用户数、群组数、活跃度）
- [ ] 系统配置
- [ ] 日志查看

**技术选型：**
- 可以用 React（Web）
- 或使用 Retool, Appsmith 等低代码平台

---

### 16. 🔧 基础设施与工具

#### 需要补充 ⚠️

**CI/CD：**
- [ ] GitHub Actions 自动测试
- [ ] 自动部署到 Fly.io（后端）
- [ ] Expo EAS Build（前端）

**监控与日志：**
- [ ] 错误追踪（Sentry）
- [ ] 性能监控（New Relic / Datadog）
- [ ] 日志聚合（ELK / CloudWatch）

**安全：**
- [ ] HTTPS 强制
- [ ] API 速率限制（已在架构审查中建议）
- [ ] SQL 注入防护（Prisma 已处理）
- [ ] XSS 防护
- [ ] 数据加密（敏感数据）
- [ ] GDPR 合规（欧洲用户）

**性能优化：**
- [ ] Redis 缓存
- [ ] CDN（图片、静态资源）
- [ ] 数据库查询优化
- [ ] API 响应压缩
- [ ] 懒加载与分页

---

## 📅 开发路线图建议

### 阶段 1：核心基础（4-6 周） 🔥

**优先级最高，必须完成：**

1. **架构重构（2 周）**
   - 实施分层架构（Service + Repository）
   - 添加输入验证（Zod）
   - 统一错误处理
   - 安全加固（Helmet, 速率限制）

2. **投票系统（1.5 周）**
   - 数据库模型
   - 后端 API（创建投票、投票、查看结果）
   - 基础功能（单选/多选）

3. **前端基础搭建（2.5 周）**
   - 项目初始化
   - 认证流程 UI
   - 主导航结构
   - API 客户端封装
   - 基础组件库

### 阶段 2：核心功能（6-8 周） 🔥

4. **前端群组功能（2 周）**
   - 群组列表、详情、创建
   - 成员管理
   - 联系人集成
   - 二维码邀请

5. **前端餐厅功能（2 周）**
   - 餐厅搜索与列表
   - 餐厅详情页
   - 地图集成
   - 发表评价

6. **餐厅数据集成（1 周）**
   - Google Places API
   - 餐厅搜索后端
   - 附近餐厅

7. **图片上传服务（1 周）**
   - S3/Cloudinary 集成
   - 前端图片选择器
   - 图片压缩

8. **AI 推荐增强（1 周）**
   - OpenAI/Claude 集成
   - Prompt 优化
   - 前端推荐页面

9. **前端投票功能（1 周）**
   - 创建投票 UI
   - 投票列表和详情
   - 实时结果展示

### 阶段 3：社交功能（4-6 周） 🟡

10. **点赞与评论后端（1 周）**
    - API 端点实现
    - 通知触发

11. **前端社区动态（2 周）**
    - Feed 瀑布流
    - 发布菜品 UI
    - 动态详情页
    - 点赞/评论交互

12. **通知系统（2 周）**
    - 后端通知模型和 API
    - 前端通知中心
    - 推送通知集成
    - 通知偏好设置

13. **邮件/短信服务（1 周）**
    - SendGrid / Twilio 集成
    - 邀请邮件/短信发送

### 阶段 4：优化与测试（4-6 周） 🟡

14. **测试覆盖（3 周）**
    - 后端单元测试
    - 后端集成测试
    - 前端组件测试

15. **性能优化（1 周）**
    - 数据库查询优化
    - API 响应缓存
    - 前端懒加载

16. **UI/UX 优化（1 周）**
    - 用户反馈调整
    - 动画和过渡
    - 加载状态

17. **文档（1 周）**
    - API 文档（Swagger）
    - 用户指南
    - 开发文档

### 阶段 5：部署与上线（2-3 周） 🟢

18. **生产环境准备（1 周）**
    - 环境变量配置
    - 数据库迁移脚本
    - 健康检查

19. **部署（1 周）**
    - 后端部署到 Fly.io
    - PostgreSQL 生产数据库
    - 前端发布到 App Store / Google Play

20. **监控与日志（1 周）**
    - Sentry 集成
    - 日志系统
    - 性能监控

### 阶段 6：高级功能（长期）🟢

21. **实时聊天**（如果需要）
22. **管理后台**
23. **高级 AI 功能**（菜品识别、营养分析）
24. **社交网络功能**（关注用户、好友系统）
25. **积分/徽章系统**（游戏化）

---

## 💡 技术依赖清单

### 后端新增依赖
```json
{
  "dependencies": {
    // 安全
    "helmet": "^8.0.0",
    "express-rate-limit": "^7.5.0",

    // 验证
    "zod": "^3.24.1",

    // 日志
    "winston": "^3.17.0",
    "morgan": "^1.10.0",

    // AI
    "openai": "^4.77.0",  // 或 "@anthropic-ai/sdk"

    // 图片
    "aws-sdk": "^2.1691.0",  // 或 "cloudinary": "^2.5.1"
    "multer": "^1.4.5-lts.1",
    "sharp": "^0.34.1",  // 图片处理

    // 邮件/短信
    "@sendgrid/mail": "^8.1.4",
    "twilio": "^5.3.5",

    // 其他
    "uuid": "^11.0.4",
    "qrcode": "^1.5.4",

    // 可选：实时
    "socket.io": "^4.8.1"
  },
  "devDependencies": {
    // 测试
    "jest": "^29.7.0",
    "@types/jest": "^29.5.14",
    "ts-jest": "^29.2.6",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.2",
    "@faker-js/faker": "^9.4.0",

    // 代码质量
    "eslint": "^9.20.0",
    "prettier": "^3.5.2",
    "@typescript-eslint/eslint-plugin": "^8.20.0",
    "@typescript-eslint/parser": "^8.20.0"
  }
}
```

### 前端依赖
```json
{
  "dependencies": {
    // 核心
    "expo": "~52.0.0",
    "react": "18.3.1",
    "react-native": "0.76.5",

    // 导航
    "@react-navigation/native": "^7.0.18",
    "@react-navigation/stack": "^7.2.1",
    "@react-navigation/bottom-tabs": "^7.2.0",
    "react-native-screens": "^4.4.0",
    "react-native-safe-area-context": "^4.14.0",

    // 状态管理
    "zustand": "^5.0.3",
    "@tanstack/react-query": "^5.64.2",

    // 表单
    "react-hook-form": "^7.54.2",
    "zod": "^3.24.1",
    "@hookform/resolvers": "^3.9.1",

    // HTTP
    "axios": "^1.7.9",

    // UI
    "nativewind": "^4.1.23",
    "react-native-reanimated": "~3.16.4",
    "react-native-gesture-handler": "~2.20.2",

    // 功能
    "expo-image-picker": "~15.0.7",
    "expo-camera": "~16.0.0",
    "expo-contacts": "~14.0.0",
    "expo-location": "~18.0.0",
    "expo-notifications": "~0.29.13",
    "expo-linking": "~7.0.0",
    "expo-barcode-scanner": "~14.0.0",  // 二维码
    "react-native-maps": "1.18.0",

    // 存储
    "@react-native-async-storage/async-storage": "^2.1.0",

    // 其他
    "date-fns": "^4.1.0",  // 日期处理
    "react-native-qrcode-svg": "^6.3.11"  // 生成二维码
  },
  "devDependencies": {
    "@babel/core": "^7.26.0",
    "@types/react": "~18.3.12",
    "typescript": "~5.6.2",

    // 测试
    "@testing-library/react-native": "^12.9.0",
    "jest": "^29.7.0",
    "jest-expo": "~52.0.4"
  }
}
```

---

## 📈 估算工作量

| 功能模块 | 后端工作量 | 前端工作量 | 总计（周） |
|---------|-----------|-----------|----------|
| 架构重构 | 2 周 | - | 2 |
| 投票系统 | 1 周 | 1 周 | 2 |
| 前端基础 | - | 2.5 周 | 2.5 |
| 群组功能（前端） | - | 2 周 | 2 |
| 餐厅功能 | 1 周 | 2 周 | 3 |
| 图片上传 | 0.5 周 | 0.5 周 | 1 |
| AI 推荐 | 1 周 | 0.5 周 | 1.5 |
| 点赞/评论 | 1 周 | 1 周 | 2 |
| 社区动态（前端） | - | 2 周 | 2 |
| 通知系统 | 1 周 | 1 周 | 2 |
| 邮件/短信 | 1 周 | - | 1 |
| 测试 | 2 周 | 1 周 | 3 |
| 优化与部署 | 1 周 | 1 周 | 2 |
| **总计** | **11.5 周** | **14.5 周** | **26 周** |

**实际预计：** 考虑到调试、集成和迭代，建议预留 **30-35 周（7-9 个月）** 完成 MVP。

如果是 **2 人团队**（1 后端 + 1 前端），可以并行开发，约 **20-24 周（5-6 个月）**。

---

## 🎯 MVP 最小可行产品

如果要快速上线，以下是 **绝对必需** 的功能：

### MVP 核心功能清单（8-12 周）

**后端：**
- [x] 认证系统
- [x] 群组 CRUD
- [x] 成员管理
- [x] 基础邀请（链接）
- [ ] 投票系统
- [ ] 餐厅搜索（Google Places）
- [ ] 基础 AI 推荐
- [ ] 图片上传

**前端：**
- [ ] 登录/注册
- [ ] 群组列表和创建
- [ ] 邀请成员（链接分享）
- [ ] 创建投票
- [ ] 投票并查看结果
- [ ] 餐厅搜索
- [ ] AI 推荐显示
- [ ] 发布菜品（简单版）

**暂时跳过（MVP 后添加）：**
- 评论/点赞
- 通知系统
- 二维码/短信邀请
- 社区动态 Feed
- 地图视图
- 管理后台

---

## 📝 总结

GroupEat 已经有了坚实的 **后端基础**，但还需要：

1. **架构改进**（2 周） - 提高代码质量和可维护性
2. **投票系统**（2 周） - 核心决策功能
3. **前端应用**（10+ 周） - 最大缺口，需要从头构建
4. **AI 推荐**（1 周） - 增强现有占位符
5. **餐厅集成**（1 周） - 真实餐厅数据
6. **图片服务**（1 周） - 菜品照片上传
7. **社交功能**（3 周） - 点赞/评论/通知
8. **测试与优化**（3 周） - 确保质量
9. **部署**（2 周） - 上线准备

**建议优先顺序：**
1. 架构重构（必须先做，为后续打基础）
2. 前端基础框架（解锁用户体验）
3. 投票系统（核心价值）
4. AI 推荐 + 餐厅集成（差异化功能）
5. 图片上传（完善社交体验）
6. 其他功能

需要我帮你开始实施某个具体功能吗？或者先从架构重构开始？
