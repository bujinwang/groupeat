-- CreateTable
CREATE TABLE "Restaurant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "googlePlaceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Restaurant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DishPost" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT,
    "restaurantId" TEXT,
    "caption" TEXT,
    "dishName" TEXT,
    "photoUrls" TEXT[],
    "rating" INTEGER,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "anonymizeInCommunity" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DishPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DishPostComment" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DishPostComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DishPostLike" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DishPostLike_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Restaurant_googlePlaceId_key" ON "Restaurant"("googlePlaceId");

-- CreateIndex
CREATE INDEX "Review_userId_idx" ON "Review"("userId");

-- CreateIndex
CREATE INDEX "Review_restaurantId_idx" ON "Review"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_userId_restaurantId_key" ON "Review"("userId", "restaurantId");

-- CreateIndex
CREATE INDEX "DishPost_userId_idx" ON "DishPost"("userId");

-- CreateIndex
CREATE INDEX "DishPost_groupId_idx" ON "DishPost"("groupId");

-- CreateIndex
CREATE INDEX "DishPost_restaurantId_idx" ON "DishPost"("restaurantId");

-- CreateIndex
CREATE INDEX "DishPost_createdAt_idx" ON "DishPost"("createdAt");

-- CreateIndex
CREATE INDEX "DishPostComment_userId_idx" ON "DishPostComment"("userId");

-- CreateIndex
CREATE INDEX "DishPostComment_postId_idx" ON "DishPostComment"("postId");

-- CreateIndex
CREATE INDEX "DishPostLike_userId_idx" ON "DishPostLike"("userId");

-- CreateIndex
CREATE INDEX "DishPostLike_postId_idx" ON "DishPostLike"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "DishPostLike_userId_postId_key" ON "DishPostLike"("userId", "postId");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishPost" ADD CONSTRAINT "DishPost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishPost" ADD CONSTRAINT "DishPost_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DiningGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishPost" ADD CONSTRAINT "DishPost_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishPostComment" ADD CONSTRAINT "DishPostComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishPostComment" ADD CONSTRAINT "DishPostComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DishPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishPostLike" ADD CONSTRAINT "DishPostLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishPostLike" ADD CONSTRAINT "DishPostLike_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DishPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
