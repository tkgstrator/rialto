-- CreateTable
CREATE TABLE "ModelProviderPreference" (
    "modelId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,

    CONSTRAINT "ModelProviderPreference_pkey" PRIMARY KEY ("modelId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelProviderPreference_modelName_priority_key" ON "ModelProviderPreference"("modelName", "priority");

-- AddForeignKey
ALTER TABLE "ModelProviderPreference" ADD CONSTRAINT "ModelProviderPreference_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;
