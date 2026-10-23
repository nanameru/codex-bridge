# Issue #51 / #53: テスト全件と再実行方法

最新のローカル実行はNode118件・Python81件、全199件成功。実API・app-server E2Eをこの件数に加算していない。

- 正本: `test-board.yaml`（Issue #51にはTC-025/029〜039、#53にはTC-040〜042を紐付け）
- 全オフラインケースの再生成: `python3 scripts/run_test_inventory.py --output test-results`
- 生の結果: `test-results/node.tap` / `python.txt` / `inventory.json`
- CI: Actionsの`case-results` artifactへケース別結果を14日保存
- E2Eと実API: `docs/tool-recovery-verification.md`。実APIは明示opt-inでのみ実行

## 追加した異常系

| ケース | 修正前 | 修正後 |
|---|---|---|
| EDGE-01 null/choices型不正 | fail | pass |
| EDGE-02 choice 0以外の混入 | fail | pass |
| EDGE-03 call_id変更/delta型不正 | fail | pass |
| EDGE-04 usage記録障害 | fail | pass |
| EDGE-05 nativeツール/引数delta混入 | fail | pass |
| EDGE-06 空回答/複数・矛盾終端 | fail | pass |
| EDGE-07 並列結果の逆順 | pass | pass |
| EDGE-08 重複DONE/不正UTF8 | fail | pass |

テストファイルは `test/protocol-edge.test.mjs`。各ケースは同じ試験内で複数の入力パターンを検証する。

# オフラインテスト全件一覧

生成: `python3 scripts/run_test_inventory.py --output test-results`。実API・app-server E2Eは別表。

| 種別 | テストファイル | ケース | 結果 |
|---|---|---|---|
| Node | test/bridge-transport.test.mjs | actual bridge sends model controls and stable conversation sessions to mock upstream | pass |
| Node | test/catalog-limits.test.mjs | every OpenCode model compacts before the lower route limit | pass |
| Node | test/catalog-limits.test.mjs | small-context models compact earlier through Codex's 90% clamp | pass |
| Node | test/catalog-safety.test.mjs | strips terminal controls and bidirectional overrides from display text | pass |
| Node | test/catalog-safety.test.mjs | rejects malformed model ids, ranges, efforts and compact limits | pass |
| Node | test/catalog-safety.test.mjs | validates the generated catalog and sanitizes remote display names | pass |
| Node | test/catalog-safety.test.mjs | writes atomically, restricts home catalog permissions and refuses symlinks | pass |
| Node | test/catalog-safety.test.mjs | rejects invalid provider payloads and preserves local compact settings | pass |
| Node | test/catalog-safety.test.mjs | parse and fetch failures are explicit and bounded | pass |
| Node | test/catalog-safety.test.mjs | make-catalog refuses to overwrite a symlinked home catalog | pass |
| Node | test/chat-protocol.test.mjs | JSON rejects truncated, malformed, error and conflicting tools without executable output | pass |
| Node | test/chat-protocol.test.mjs | SSE cannot execute tools on EOF without finish_reason or on length/content_filter | pass |
| Node | test/chat-protocol.test.mjs | valid SSE preserves UTF8, reasoning, usage and exactly one completed tool | pass |
| Node | test/chat-protocol.test.mjs | SSE accepts final frame without newline, rejects malformed JSON and does not duplicate text | pass |
| Node | test/chat-protocol.test.mjs | assistant commentary, reasoning and calls form one message; results survive once | pass |
| Node | test/compaction-handoff.test.mjs | intra-turn boundaries keep parallel and unresolved tool exchanges intact | pass |
| Node | test/compaction-handoff.test.mjs | budget boundary keeps recent turns and never splits a tool execution across user steering | pass |
| Node | test/compaction-handoff.test.mjs | explicit history handoff preserves directives and unresolved current tools without needing a compaction item | pass |
| Node | test/compaction-handoff.test.mjs | repairs legacy custom tool IDs in native handoff summaries without editing history | pass |
| Node | test/compaction-handoff.test.mjs | releases a completed SSE handoff without waiting for the connection to close | pass |
| Node | test/compaction-handoff.test.mjs | reuses handoff despite instruction and display metadata changes, preserving current instructions | pass |
| Node | test/compaction-handoff.test.mjs | deduplicates concurrent summaries and a cancelled waiter does not cancel another | pass |
| Node | test/compaction-handoff.test.mjs | isolates threads, credentials and changed history; failed summaries are retried | pass |
| Node | test/compaction-handoff.test.mjs | does not cache requests lacking a usable thread ID | pass |
| Node | test/compaction-handoff.test.mjs | handles cancellation during synchronous fetch setup before waiter registration | pass |
| Node | test/compaction-handoff.test.mjs | aborts generation when all waiters leave and never caches its result | pass |
| Node | test/context-input.test.mjs | removes only adjacent identical instruction messages without trimming conversation or tool history | pass |
| Node | test/handoff-status.test.mjs | App/CLI commentary arrives while summary is pending; response IDs, indexes and sequences remain consistent | pass |
| Node | test/handoff-status.test.mjs | cache hits, immediate handoffs and native requests do not inject status | pass |
| Node | test/handoff-status.test.mjs | non-stream requests preserve JSON and failure HTTP status | pass |
| Node | test/handoff-status.test.mjs | a failed handoff sends a terminal failure after status without dropping history or leaking upstream bodies | pass |
| Node | test/handoff-status.test.mjs | upstream errors after handoff remain failures rather than successful completed answers | pass |
| Node | test/handoff-status.test.mjs | split UTF-8 SSE and JSON upstreams preserve final model text | pass |
| Node | test/handoff-status.test.mjs | shared waiters receive independent statuses and one summary | pass |
| Node | test/handoff-status.test.mjs | closing the waiting client cancels its summary and timeout terminates the status stream | pass |
| Node | test/handoff-status.test.mjs | bridge-only status is not replayed as model context; ordinary commentary and all user data remain | pass |
| Node | test/handoff-status.test.mjs | status does not alter custom tool arguments, call IDs or response ordering | pass |
| Node | test/handoff-status.test.mjs | one shared client may cancel without cancelling the remaining status waiter | pass |
| Node | test/handoff-status.test.mjs | budget summary reports input reduction rather than a model switch | pass |
| Node | test/handoff-status.test.mjs | router chooses budget notification for both new summaries and extended compacted history | pass |
| Node | test/image-tool-results.test.mjs | parallel tool image outputs stay images after all tool results, not JSON Base64 text | pass |
| Node | test/image-tool-results.test.mjs | text-only and JSON-string tool results are not reinterpreted as images | pass |
| Node | test/image-tool-results.test.mjs | tool image results retain call association for mixed text and image parallel batches | pass |
| Node | test/local-security.test.mjs | rejects arbitrary Bearer tokens on native and OpenCode routes before calling upstream | pass |
| Node | test/local-security.test.mjs | rejects browser Origins and foreign Hosts even with the owner credential | pass |
| Node | test/local-security.test.mjs | owner authentication is reloaded after refresh; missing, public and linked files fail closed | pass |
| Node | test/local-security.test.mjs | internal bridge credentials never accompany native or official OpenCode requests | pass |
| Node | test/local-security.test.mjs | a missing internal key never falls back to unauthenticated legacy forwarding | pass |
| Node | test/local-security.test.mjs | expired owner JWTs and malformed credential files never authorize OpenCode | pass |
| Node | test/local-security.test.mjs | legacy upstream is official-only and never follows redirects with credentials or history | pass |
| Node | test/model-router.test.mjs | direct authentication uses API keys only and never extracts login credentials | pass |
| Node | test/model-router.test.mjs | official Responses bypasses conversion, GPT summaries and heuristic budget rejection | pass |
| Node | test/model-router.test.mjs | direct Responses fails closed without OpenCode credentials and never falls back to GPT | pass |
| Node | test/model-router.test.mjs | existing sessions without the direct marker keep their legacy transport | pass |
| Node | test/model-router.test.mjs | direct Responses preserves native custom events, normalizes phases, and never falls back | pass |
| Node | test/model-router.test.mjs | routes both switching directions without changing thread metadata or messages | pass |
| Node | test/model-router.test.mjs | never forwards native authentication or account headers to OpenCode | pass |
| Node | test/model-router.test.mjs | repairs persisted legacy custom IDs before native responses and remote compaction | pass |
| Node | test/model-router.test.mjs | preserves the already-deployed native image and search endpoints independently of chat models | pass |
| Node | test/model-router.test.mjs | rejects unknown models and missing authentication before forwarding | pass |
| Node | test/model-router.test.mjs | uses explicit namespaces for overlapping models | pass |
| Node | test/model-router.test.mjs | filters provider-specific reasoning without editing the original history | pass |
| Node | test/model-router.test.mjs | never follows redirects carrying native credentials | pass |
| Node | test/model-router.test.mjs | rejects external native or bridge targets | pass |
| Node | test/model-router.test.mjs | refuses provider-specific continuation IDs and oversized bodies | pass |
| Node | test/model-router.test.mjs | accepts compressed Codex requests without forwarding encoding headers | pass |
| Node | test/model-router.test.mjs | limits decompressed data and rejects unsupported encodings | pass |
| Node | test/model-router.test.mjs | rejects opaque references and a missing summary model without discarding history | pass |
| Node | test/model-router.test.mjs | summarizes compacted context only for that thread and keeps native chats unchanged | pass |
| Node | test/model-router.test.mjs | does not reuse a handoff across accounts or forward a failed summary to OpenCode | pass |
| Node | test/model-router.test.mjs | requires a completed summary and handles split SSE without sharing concurrent threads | pass |
| Node | test/model-router.test.mjs | times out an unresponsive upstream | pass |
| Node | test/model-router.test.mjs | records per-stage timings and cache outcomes without logging credentials or conversation | pass |
| Node | test/model-router.test.mjs | rejects an OpenCode request over the input budget before contacting upstream | pass |
| Node | test/model-router.test.mjs | records a soft budget warning while allowing the request | pass |
| Node | test/model-router.test.mjs | estimates token density for ASCII and non-ASCII input | pass |
| Node | test/model-router.test.mjs | recovers an over-budget history once, preserving schemas, current work and auth isolation | pass |
| Node | test/model-router.test.mjs | does not summarize in-budget or native requests, or when recovery is disabled or cannot help | pass |
| Node | test/model-router.test.mjs | summarizes at the soft threshold before reaching the hard limit | pass |
| Node | test/model-router.test.mjs | a failed or insufficient budget summary never forwards oversized context or retries endlessly | pass |
| Node | test/model-router.test.mjs | extends the original compaction handoff to older completed turns instead of summarizing twice | pass |
| Node | test/model-router.test.mjs | recovers completed tool history within one turn, including after native compaction | pass |
| Node | test/model-router.test.mjs | records reversed soft/hard limits while still recovering at the hard threshold | pass |
| Node | test/model-router.test.mjs | records received bytes for rejected and empty input | pass |
| Node | test/model-router.test.mjs | streams first output before completion even with metrics enabled | pass |
| Node | test/model-router.test.mjs | all OpenCode models share history handoff after switching or resuming | pass |
| Node | test/model-router.test.mjs | default history handoff stops every route on summary failure | pass |
| Node | test/model-router.test.mjs | image budget counts structured user and parallel tool images without charging Base64 as text | pass |
| Node | test/model-router.test.mjs | image budget never discounts Base64 in plain text, schemas or malformed image sources | pass |
| Node | test/model-router.test.mjs | image token reservation does not bypass the raw request byte limit | pass |
| Node | test/protocol-edge.test.mjs | EDGE-01 null and malformed choices return non-retry failure without throwing | pass |
| Node | test/protocol-edge.test.mjs | EDGE-02 choice one cannot dispatch a tool when choice zero is the answer | pass |
| Node | test/protocol-edge.test.mjs | EDGE-03 changing a streamed call ID and malformed delta types cannot complete a tool | pass |
| Node | test/protocol-edge.test.mjs | EDGE-04 telemetry failure cannot change a valid completed tool into a failed response | pass |
| Node | test/protocol-edge.test.mjs | EDGE-05 recovery rejects native executable items and tool deltas | pass |
| Node | test/protocol-edge.test.mjs | EDGE-06 recovery rejects empty answers and contradictory or multiple terminal events | pass |
| Node | test/protocol-edge.test.mjs | EDGE-07 parallel results may arrive reversed without losing call IDs or duplicating messages | pass |
| Node | test/protocol-edge.test.mjs | EDGE-08 repeated stream terminal and invalid UTF8 are non-retry failures with no tools | pass |
| Node | test/tool-adapter.test.mjs | normalizes only mismatched tool item prefixes idempotently and preserves execution IDs | pass |
| Node | test/tool-adapter.test.mjs | preserves freeform tool history and schemas through the chat bridge | pass |
| Node | test/tool-adapter.test.mjs | restores freeform outputs while leaving regular functions unchanged | pass |
| Node | test/tool-adapter.test.mjs | adapts split UTF-8 SSE items and final response without buffering the whole stream | pass |
| Node | test/tool-adapter.test.mjs | adapts non-streaming JSON responses | pass |
| Node | test/tool-adapter.test.mjs | normalizes OpenCode assistant messages to GPT-compatible phases | pass |
| Node | test/tool-adapter.test.mjs | adds final_answer phase to streamed OpenCode assistant messages | pass |
| Node | test/tool-adapter.test.mjs | normalizes phases on direct Responses SSE without changing other items | pass |
| Node | test/tool-adapter.test.mjs | normalizes phases on direct non-streaming Responses JSON | pass |
| Node | test/tool-adapter.test.mjs | repairs trailing bridge reasoning for each assistant message and tool group without crossing turns | pass |
| Node | test/tool-adapter.test.mjs | completes reasoning before assistant items even when the bridge emits it last | pass |
| Node | test/tool-adapter.test.mjs | bounds expanded history and does not invent missing reasoning | pass |
| Node | test/tool-adapter.test.mjs | does not release a tool call on a truncated or failed reasoning stream | pass |
| Node | test/tool-loop.test.mjs | repeated completed results recover, while deliberate polling and changing results can exceed six calls | pass |
| Node | test/tool-loop.test.mjs | changing tools/arguments and waiting loops have a finite turn budget, new users reset it | pass |
| Node | test/tool-loop.test.mjs | parallel calls count as one round and a normal operation is never rewritten | pass |
| Node | test/tool-loop.test.mjs | router requests a single tool-free answer preserving results and native requests | pass |
| Node | test/tool-loop.test.mjs | provider ignoring tool_choice cannot dispatch tools during recovery | pass |
| Node | test/upstream-options.test.mjs | maps DeepSeek thinking controls without silently lowering the selected effort | pass |
| Node | test/upstream-options.test.mjs | keeps session stable per thread across models without exposing thread IDs | pass |
| Python | test/test_code_mode_probe.py | test_code_mode_probe.CodeModeProbeTests.test_changes_only_flash_tool_metadata | pass |
| Python | test/test_code_mode_probe.py | test_code_mode_probe.CodeModeProbeTests.test_rejects_legacy_transport_and_missing_flash | pass |
| Python | test/test_direct_config.py | test_direct_config.DirectConfigTests.test_adds_isolated_official_profile_without_changing_defaults | pass |
| Python | test/test_direct_config.py | test_direct_config.DirectConfigTests.test_does_not_overwrite_a_custom_provider_or_profile | pass |
| Python | test/test_direct_config.py | test_direct_config.DirectConfigTests.test_launcher_keeps_api_key_out_of_arguments_and_configuration | pass |
| Python | test/test_direct_config.py | test_direct_config.DirectConfigTests.test_never_reads_login_database | pass |
| Python | test/test_direct_config.py | test_direct_config.DirectConfigTests.test_preserves_an_existing_external_profile | pass |
| Python | test/test_live_comparison.py | test_live_comparison.ComparisonTests.test_comparison_is_explicitly_opt_in | pass |
| Python | test/test_live_comparison.py | test_live_comparison.ComparisonTests.test_equal_conditions_fresh_history_and_no_prompt_override | pass |
| Python | test/test_live_comparison.py | test_live_comparison.ComparisonTests.test_error_or_tool_use_stops_without_printing_content | pass |
| Python | test/test_live_comparison.py | test_live_comparison.ComparisonTests.test_isolated_settings_preserve_global_instructions_and_original_home | pass |
| Python | test/test_live_comparison.py | test_live_comparison.ComparisonTests.test_old_router_is_rejected_before_model_calls | pass |
| Python | test/test_local_operations.py | test_local_operations.LocalOperationsTests.test_doctor_is_read_only_and_never_displays_secret_or_exception_content | pass |
| Python | test/test_local_operations.py | test_local_operations.LocalOperationsTests.test_failed_runtime_verification_restores_definition_and_running_service | pass |
| Python | test/test_local_operations.py | test_local_operations.LocalOperationsTests.test_first_install_failure_removes_only_the_new_registration | pass |
| Python | test/test_local_operations.py | test_local_operations.LocalOperationsTests.test_health_never_probes_inference_on_an_unprotected_or_wrong_revision_service | pass |
| Python | test/test_local_operations.py | test_local_operations.LocalOperationsTests.test_internal_key_is_private_exclusive_and_stable | pass |
| Python | test/test_local_operations.py | test_local_operations.LocalOperationsTests.test_legacy_update_does_not_wait_for_or_restart_an_unrelated_native_stream | pass |
| Python | test/test_local_operations.py | test_local_operations.LocalOperationsTests.test_managed_security_helper_can_upgrade_but_unknown_edits_are_preserved | pass |
| Python | test/test_local_operations.py | test_local_operations.LocalOperationsTests.test_rejection_probe_uses_only_an_invalid_credential_and_no_user_input | pass |
| Python | test/test_local_operations.py | test_local_operations.LocalOperationsTests.test_security_patch_is_idempotent_and_preserves_unknown_functionality | pass |
| Python | test/test_local_operations.py | test_local_operations.LocalOperationsTests.test_waits_for_both_services_and_does_not_restart_busy_processes | pass |
| Python | test/test_local_operations.py | test_local_operations.LocalOperationsTests.test_wrong_key_content_and_shared_parent_never_get_overwritten | pass |
| Python | test/test_patch_chat_protocol.py | test_patch_chat_protocol.ChatProtocolPatchTests.test_drift_refused_and_backups_created_once | pass |
| Python | test/test_patch_chat_protocol.py | test_patch_chat_protocol.ChatProtocolPatchTests.test_patch_is_idempotent_and_preserves_other_legacy_functions | pass |
| Python | test/test_patch_legacy_bridge.py | test_patch_legacy_bridge.LegacyPatchTests.test_patches_only_known_fragments_and_is_idempotent | pass |
| Python | test/test_patch_legacy_bridge.py | test_patch_legacy_bridge.LegacyPatchTests.test_refuses_source_drift_and_partial_patches | pass |
| Python | test/test_patch_legacy_bridge.py | test_patch_legacy_bridge.LegacyPatchTests.test_refuses_symlinks_and_existing_different_modules_without_writes | pass |
| Python | test/test_patch_legacy_bridge.py | test_patch_legacy_bridge.LegacyPatchTests.test_upgrades_known_helper_with_one_backup_and_preserves_bridge_source | pass |
| Python | test/test_recover_thread.py | test_recover_thread.LegacySwitchTests.test_existing_provider_and_multiline_text_preserved | pass |
| Python | test/test_recover_thread.py | test_recover_thread.LegacySwitchTests.test_invalid_input_never_changes_config_or_backup | pass |
| Python | test/test_recover_thread.py | test_recover_thread.LegacySwitchTests.test_invalid_port_keeps_original_and_creates_no_backup | pass |
| Python | test/test_recover_thread.py | test_recover_thread.LegacySwitchTests.test_legacy_off_uses_normal_backup_and_keeps_provider | pass |
| Python | test/test_recover_thread.py | test_recover_thread.LegacySwitchTests.test_legacy_off_without_baseline_uses_codex_defaults | pass |
| Python | test/test_recover_thread.py | test_recover_thread.LegacySwitchTests.test_off_preserves_a_new_normal_model_selection | pass |
| Python | test/test_recover_thread.py | test_recover_thread.LegacySwitchTests.test_repair_changes_only_missing_provider | pass |
| Python | test/test_recover_thread.py | test_recover_thread.LegacySwitchTests.test_round_trip_preserves_provider_and_profiles | pass |
| Python | test/test_recover_thread.py | test_recover_thread.RecoveryTests.test_accepts_native_reasoning_and_codex_models | pass |
| Python | test/test_recover_thread.py | test_recover_thread.RecoveryTests.test_checks_returned_provider | pass |
| Python | test/test_recover_thread.py | test_recover_thread.RecoveryTests.test_forks_history_to_openai_without_starting_a_turn | pass |
| Python | test/test_recover_thread.py | test_recover_thread.RecoveryTests.test_handles_missing_fork_metadata_without_naming_a_thread | pass |
| Python | test/test_recover_thread.py | test_recover_thread.RecoveryTests.test_handles_missing_or_invalid_thread_metadata | pass |
| Python | test/test_recover_thread.py | test_recover_thread.RecoveryTests.test_kills_only_its_child_if_graceful_shutdown_times_out | pass |
| Python | test/test_recover_thread.py | test_recover_thread.RecoveryTests.test_reads_notifications_and_server_errors_over_stdio | pass |
| Python | test/test_recover_thread.py | test_recover_thread.RecoveryTests.test_refuses_a_thread_that_already_uses_openai | pass |
| Python | test/test_recover_thread.py | test_recover_thread.RecoveryTests.test_refuses_running_original_without_mutating_it | pass |
| Python | test/test_recover_thread.py | test_recover_thread.RecoveryTests.test_rejects_bridge_defaults_before_opening_a_server | pass |
| Python | test/test_recover_thread.py | test_recover_thread.RecoveryTests.test_rejects_non_native_model_before_opening_a_server | pass |
| Python | test/test_switch.py | test_switch.SwitchTests.test_existing_provider_and_multiline_text_preserved | pass |
| Python | test/test_switch.py | test_switch.SwitchTests.test_invalid_input_never_changes_config_or_backup | pass |
| Python | test/test_switch.py | test_switch.SwitchTests.test_invalid_port_keeps_original_and_creates_no_backup | pass |
| Python | test/test_switch.py | test_switch.SwitchTests.test_legacy_off_uses_normal_backup_and_keeps_provider | pass |
| Python | test/test_switch.py | test_switch.SwitchTests.test_legacy_off_without_baseline_uses_codex_defaults | pass |
| Python | test/test_switch.py | test_switch.SwitchTests.test_off_preserves_a_new_normal_model_selection | pass |
| Python | test/test_switch.py | test_switch.SwitchTests.test_repair_changes_only_missing_provider | pass |
| Python | test/test_switch.py | test_switch.SwitchTests.test_round_trip_preserves_provider_and_profiles | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_common_history_accepts_every_model_and_removes_old_direct_marker | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_flash_code_mode_changes_only_tool_metadata_and_is_idempotent | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_flash_code_mode_refuses_non_direct_settings | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_gpt_activation_preserves_a_concurrent_model_change | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_gpt_activation_refuses_wrong_catalog_and_custom_provider | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_legacy_switch_restores_missing_native_route_in_unified_mode | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_new_cli_modes_never_fall_through_to_legacy_on_off | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_normal_activation_keeps_gpt_default_and_routes_both_model_choices | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_normal_activation_refuses_old_router_unknown_model_and_custom_provider | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_normal_codex_uses_custom_provider_for_standard_local_compaction | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_only_officially_supported_models_use_direct_responses | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_pins_frequent_models_at_top_without_reordering_the_rest | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_prepare_sanitizes_display_text_and_rejects_bad_ids | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_prepares_namespaced_catalog_without_overwriting_sources | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_preserves_multiline_content_and_quoted_provider_name | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_prioritize_handles_a_missing_pinned_model | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_protected_install_never_reenables_a_legacy_unprotected_router | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_refuses_a_busy_or_unreadable_connection_state | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_refuses_a_different_catalog_without_changing_config | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_refuses_custom_provider_credentials | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_round_trip_and_legacy_switch_preserve_models_and_settings | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_transport_migration_keeps_all_native_model_metadata_unchanged | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_unified_switch_never_points_native_auth_at_a_remote_bridge | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_waits_for_active_conversations_without_stopping_them | pass |
| Python | test/test_unified_config.py | test_unified_config.UnifiedConfigTests.test_waits_until_old_launchd_registration_is_removed | pass |

## 旧ブリッジへの再適用

`LEGACY_BRIDGE_SOURCE=/Users/kimurataiyou/home-runner/bridge/codex-bridge.mjs node --test test/bridge-transport.test.mjs` も成功。
追加importがあるだけでsecurityパッチの再適用が拒否される不具合を修正した。
認証・ログ保護の欠落や管理外helperの上書きは引き続き拒否する。既存Pythonケースへ再適用と保護欠落の検証を追加した。

## 実モデル試験の注意

オフライン193件がすべて成功しても実モデルの全成功を意味しない。今回の実APIではHY4の結果文字列照合が初回失敗し、追加1要求では成功した。失敗も `docs/tool-recovery-verification.md` とIssue #51へ残している。
