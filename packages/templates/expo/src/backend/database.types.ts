// Initial notes recipe. Regenerate from the app database after schema changes.
export type Database = {
  public: {
    Tables: {
      notes: {
        Row: { id: string; owner_id: string; body: string; created_at: string };
        Insert: { id?: string; owner_id?: string; body: string; created_at?: string };
        Update: { body?: string };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
