DROP TABLE IF EXISTS public.learning_state;
DROP TABLE IF EXISTS public.learning_profiles;

CREATE TABLE public.learning_profiles (
  profile_id text PRIMARY KEY,
  track_id text NOT NULL,
  track_version integer NOT NULL CHECK (track_version >= 1),
  selected_level_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  current_run_id text,
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.learning_state (
  profile_id text NOT NULL REFERENCES public.learning_profiles(profile_id) ON DELETE CASCADE,
  record_type text NOT NULL CHECK (record_type IN ('run', 'skill', 'review')),
  record_id text NOT NULL,
  lesson_id text,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, record_type, record_id)
);

CREATE INDEX learning_state_lesson_idx
  ON public.learning_state (profile_id, lesson_id);
