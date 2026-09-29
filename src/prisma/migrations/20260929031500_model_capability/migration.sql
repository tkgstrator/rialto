-- What a subscription model accepts (effort levels, Claude `thinking` off settings), read once per model.
CREATE TABLE "ModelCapability" (
    "modelId" TEXT NOT NULL,
    "efforts" TEXT[],
    "thinkingProbedAt" TIMESTAMP(3),
    "thinkingDisabled" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "thinkingBetweenTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelCapability_pkey" PRIMARY KEY ("modelId")
);

ALTER TABLE "ModelCapability" ADD CONSTRAINT "ModelCapability_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;
