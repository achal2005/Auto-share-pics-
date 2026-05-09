-- ============================================================
-- AutoSharePics - Useful Queries
-- ============================================================

-- 1. See all sessions and their stats
SELECT * FROM v_session_summary ORDER BY started_at DESC;

-- 2. Which friends appear most often?
SELECT unnest(friends_identified) AS friend, COUNT(*) AS appearances
FROM media_files WHERE status IN ('processed', 'delivered')
GROUP BY friend ORDER BY appearances DESC;

-- 3. Undelivered media ready to send
SELECT * FROM v_ready_to_deliver;

-- 4. Delivery history for a specific session
SELECT dl.*, m.original_filename
FROM delivery_logs dl
JOIN media_files m ON dl.media_file_id = m.id
WHERE dl.session_id = 'SESSION_UUID_HERE'
ORDER BY dl.sent_at;

-- 5. Failed deliveries that need attention
SELECT m.original_filename, dl.recipient_name, dl.error_message, dl.retry_count
FROM delivery_logs dl
JOIN media_files m ON dl.media_file_id = m.id
WHERE dl.status = 'failed';

-- 6. Media stuck in processing
SELECT id, original_filename, status, process_attempts, last_error, ingested_at
FROM media_files
WHERE status IN ('pending', 'processing') AND process_attempts >= 3;

-- 7. Monthly stats
SELECT
  date_trunc('month', m.ingested_at) AS month,
  COUNT(*) AS total_media,
  COUNT(CASE WHEN m.is_video THEN 1 END) AS videos,
  COUNT(CASE WHEN NOT m.is_video THEN 1 END) AS photos,
  COUNT(DISTINCT m.session_id) AS sessions
FROM media_files m
GROUP BY month ORDER BY month DESC;

-- 8. All active friends with their consent status
SELECT subject_name, display_name, phone_number, consent_given, is_active
FROM friends_contacts ORDER BY display_name;

-- 9. Reset a stuck file for reprocessing
-- UPDATE media_files SET status = 'pending', process_attempts = 0 WHERE id = 'UUID_HERE';

-- 10. Purge old delivery logs (keep last 90 days)
-- DELETE FROM delivery_logs WHERE created_at < NOW() - INTERVAL '90 days';
