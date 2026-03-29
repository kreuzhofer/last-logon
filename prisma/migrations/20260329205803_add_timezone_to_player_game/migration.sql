-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_player_games" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "chapter" TEXT NOT NULL DEFAULT 'prologue',
    "phase" TEXT NOT NULL DEFAULT 'prologue',
    "killer_alias" TEXT NOT NULL DEFAULT 'AXIOM',
    "killer_profile" TEXT NOT NULL DEFAULT '{}',
    "player_profile" TEXT NOT NULL DEFAULT '{}',
    "story_log" TEXT NOT NULL DEFAULT '[]',
    "unlocked_features" TEXT NOT NULL DEFAULT '[]',
    "active_clues" TEXT NOT NULL DEFAULT '[]',
    "solved_puzzles" TEXT NOT NULL DEFAULT '[]',
    "discovered_secrets" TEXT NOT NULL DEFAULT '[]',
    "completed_beats" TEXT NOT NULL DEFAULT '[]',
    "killer_mood" TEXT NOT NULL DEFAULT 'charming',
    "killer_trust" INTEGER NOT NULL DEFAULT 0,
    "suspicion_level" INTEGER NOT NULL DEFAULT 0,
    "total_sessions" INTEGER NOT NULL DEFAULT 0,
    "total_interactions" INTEGER NOT NULL DEFAULT 0,
    "story_summary" TEXT NOT NULL DEFAULT '',
    "flags" TEXT NOT NULL DEFAULT '{}',
    "last_activity" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_ai_call" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "player_games_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_player_games" ("active_clues", "chapter", "completed_beats", "created_at", "discovered_secrets", "flags", "id", "killer_alias", "killer_mood", "killer_profile", "killer_trust", "language", "last_activity", "last_ai_call", "phase", "player_profile", "solved_puzzles", "story_log", "story_summary", "suspicion_level", "total_interactions", "total_sessions", "unlocked_features", "updated_at", "user_id") SELECT "active_clues", "chapter", "completed_beats", "created_at", "discovered_secrets", "flags", "id", "killer_alias", "killer_mood", "killer_profile", "killer_trust", "language", "last_activity", "last_ai_call", "phase", "player_profile", "solved_puzzles", "story_log", "story_summary", "suspicion_level", "total_interactions", "total_sessions", "unlocked_features", "updated_at", "user_id" FROM "player_games";
DROP TABLE "player_games";
ALTER TABLE "new_player_games" RENAME TO "player_games";
CREATE UNIQUE INDEX "player_games_user_id_key" ON "player_games"("user_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
