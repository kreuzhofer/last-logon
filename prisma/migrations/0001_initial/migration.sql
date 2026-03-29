-- CreateTable
CREATE TABLE "users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "handle" TEXT NOT NULL,
    "real_name" TEXT,
    "email" TEXT,
    "password_hash" TEXT NOT NULL,
    "totp_secret" TEXT,
    "ssh_public_key" TEXT,
    "access_level" INTEGER NOT NULL DEFAULT 20,
    "location" TEXT NOT NULL DEFAULT '',
    "affiliation" TEXT NOT NULL DEFAULT '',
    "signature" TEXT NOT NULL DEFAULT '',
    "slow_reveal" BOOLEAN NOT NULL DEFAULT true,
    "baud_rate" INTEGER NOT NULL DEFAULT 19200,
    "total_calls" INTEGER NOT NULL DEFAULT 0,
    "total_posts" INTEGER NOT NULL DEFAULT 0,
    "total_uploads" INTEGER NOT NULL DEFAULT 0,
    "total_downloads" INTEGER NOT NULL DEFAULT 0,
    "upload_kb" INTEGER NOT NULL DEFAULT 0,
    "download_kb" INTEGER NOT NULL DEFAULT 0,
    "time_limit_min" INTEGER NOT NULL DEFAULT 60,
    "time_used_today_min" INTEGER NOT NULL DEFAULT 0,
    "first_login_at" DATETIME,
    "last_login_at" DATETIME,
    "last_login_from" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "nodes" (
    "node_number" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER,
    "remote_address" TEXT,
    "connected_at" DATETIME,
    "activity" TEXT NOT NULL DEFAULT 'Idle',
    "authenticated" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "nodes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "system_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "node" INTEGER,
    "user_id" INTEGER,
    "message" TEXT NOT NULL,
    "metadata" TEXT
);

-- CreateTable
CREATE TABLE "oneliners" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "player_game_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "handle" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "posted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oneliners_player_game_id_fkey" FOREIGN KEY ("player_game_id") REFERENCES "player_games" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "oneliners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "polls" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "question" TEXT NOT NULL,
    "created_by" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "polls_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "poll_options" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "poll_id" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "poll_options_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "poll_votes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "poll_id" INTEGER NOT NULL,
    "option_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "voted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "poll_votes_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "poll_votes_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "poll_options" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "poll_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "bulletins" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "player_game_id" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "art_file" TEXT,
    "body" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bulletins_player_game_id_fkey" FOREIGN KEY ("player_game_id") REFERENCES "player_games" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "last_callers" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "player_game_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "handle" TEXT NOT NULL,
    "location" TEXT,
    "node" INTEGER,
    "login_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "last_callers_player_game_id_fkey" FOREIGN KEY ("player_game_id") REFERENCES "player_games" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "last_callers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "message_conferences" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "min_access_level" INTEGER NOT NULL DEFAULT 20
);

-- CreateTable
CREATE TABLE "message_areas" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "conference_id" INTEGER NOT NULL,
    "tag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "min_read_level" INTEGER NOT NULL DEFAULT 20,
    "min_write_level" INTEGER NOT NULL DEFAULT 20,
    "max_messages" INTEGER NOT NULL DEFAULT 500,
    "bridge_config" TEXT,
    CONSTRAINT "message_areas_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "message_conferences" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "messages" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "player_game_id" INTEGER NOT NULL,
    "area_id" INTEGER NOT NULL,
    "reply_to_id" INTEGER,
    "from_user_id" INTEGER,
    "from_name" TEXT NOT NULL,
    "to_name" TEXT NOT NULL DEFAULT 'All',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'local',
    "origin_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "messages_player_game_id_fkey" FOREIGN KEY ("player_game_id") REFERENCES "player_games" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "messages_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "message_areas" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "messages" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "messages_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "message_read" (
    "user_id" INTEGER NOT NULL,
    "area_id" INTEGER NOT NULL,
    "last_read_id" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("user_id", "area_id"),
    CONSTRAINT "message_read_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "message_read_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "message_areas" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "door_games" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "command" TEXT,
    "dropfile_type" TEXT NOT NULL DEFAULT 'DOOR32.SYS',
    "max_nodes" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "min_access_level" INTEGER NOT NULL DEFAULT 20
);

-- CreateTable
CREATE TABLE "game_state" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game_tag" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "game_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "game_scores" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game_tag" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "handle" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "metadata" TEXT,
    "scored_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "game_scores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "player_games" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
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

-- CreateTable
CREATE TABLE "game_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "player_game_id" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "chapter" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '{}',
    "importance" INTEGER NOT NULL DEFAULT 5,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "game_events_player_game_id_fkey" FOREIGN KEY ("player_game_id") REFERENCES "player_games" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "game_npcs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "player_game_id" INTEGER NOT NULL,
    "handle" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "personality" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "relationship" TEXT NOT NULL DEFAULT 'stranger',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "game_npcs_player_game_id_fkey" FOREIGN KEY ("player_game_id") REFERENCES "player_games" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "game_conversations" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "game_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "game_notifications" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "game_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "game_puzzle_state" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "puzzle_tag" TEXT NOT NULL,
    "solved" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "hints_used" INTEGER NOT NULL DEFAULT 0,
    "solved_at" DATETIME,
    "instance_data" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "game_puzzle_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_handle_key" ON "users"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_user_id_key" ON "nodes"("user_id");

-- CreateIndex
CREATE INDEX "system_log_timestamp_idx" ON "system_log"("timestamp");

-- CreateIndex
CREATE INDEX "system_log_category_idx" ON "system_log"("category");

-- CreateIndex
CREATE INDEX "oneliners_player_game_id_idx" ON "oneliners"("player_game_id");

-- CreateIndex
CREATE UNIQUE INDEX "poll_votes_poll_id_user_id_key" ON "poll_votes"("poll_id", "user_id");

-- CreateIndex
CREATE INDEX "bulletins_player_game_id_idx" ON "bulletins"("player_game_id");

-- CreateIndex
CREATE UNIQUE INDEX "bulletins_player_game_id_number_key" ON "bulletins"("player_game_id", "number");

-- CreateIndex
CREATE INDEX "last_callers_player_game_id_idx" ON "last_callers"("player_game_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_conferences_tag_key" ON "message_conferences"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "message_areas_tag_key" ON "message_areas"("tag");

-- CreateIndex
CREATE INDEX "messages_player_game_id_area_id_created_at_idx" ON "messages"("player_game_id", "area_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_origin_origin_id_idx" ON "messages"("origin", "origin_id");

-- CreateIndex
CREATE UNIQUE INDEX "door_games_tag_key" ON "door_games"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "game_state_game_tag_user_id_key" ON "game_state"("game_tag", "user_id");

-- CreateIndex
CREATE INDEX "game_scores_game_tag_score_idx" ON "game_scores"("game_tag", "score" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "player_games_user_id_key" ON "player_games"("user_id");

-- CreateIndex
CREATE INDEX "game_events_player_game_id_created_at_idx" ON "game_events"("player_game_id", "created_at");

-- CreateIndex
CREATE INDEX "game_events_player_game_id_importance_idx" ON "game_events"("player_game_id", "importance");

-- CreateIndex
CREATE UNIQUE INDEX "game_npcs_player_game_id_handle_key" ON "game_npcs"("player_game_id", "handle");

-- CreateIndex
CREATE INDEX "game_conversations_user_id_created_at_idx" ON "game_conversations"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "game_notifications_user_id_read_idx" ON "game_notifications"("user_id", "read");

-- CreateIndex
CREATE UNIQUE INDEX "game_puzzle_state_user_id_puzzle_tag_key" ON "game_puzzle_state"("user_id", "puzzle_tag");

