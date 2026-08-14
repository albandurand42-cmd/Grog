import { supabase } from './supabase.js';

export async function fetchPendingRequests() {
  const { data, error } = await supabase
    .from('song_requests')
    .select('*')
    .eq('status', 'waiting')
    .order('request_count', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) throw error;

  return data || [];
}

export async function submitRequest(track, requestedBy = '') {
  const current = await fetchPendingRequests();

  const existing = current.find(
    item => item.spotify_track_id === track.spotify_track_id
  );

  if (existing) {
    const { error } = await supabase.rpc('increment_request_votes', {
      track_id: track.spotify_track_id
    });

    if (error) throw error;

    return {
      existing: true
    };
  }

  const { error } = await supabase
    .from('song_requests')
    .insert({
      spotify_track_id: track.spotify_track_id,
      title: track.title,
      artist: track.artist,
      image_url: track.image_url,
      status: 'waiting',
      request_count: 1
    });

  if (error) throw error;

  return {
    existing: false
  };
}

export function subscribeToQueue(callback) {
  return supabase
    .channel('song-requests-live')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'song_requests'
      },
      () => callback()
    )
    .subscribe();
}
