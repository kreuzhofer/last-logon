/*
  Warnings:

  - Added the required column `player_game_id` to the `polls` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_polls" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "player_game_id" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "created_by" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "polls_player_game_id_fkey" FOREIGN KEY ("player_game_id") REFERENCES "player_games" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "polls_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_polls" ("active", "created_at", "created_by", "id", "question") SELECT "active", "created_at", "created_by", "id", "question" FROM "polls";
DROP TABLE "polls";
ALTER TABLE "new_polls" RENAME TO "polls";
CREATE INDEX "polls_player_game_id_idx" ON "polls"("player_game_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
