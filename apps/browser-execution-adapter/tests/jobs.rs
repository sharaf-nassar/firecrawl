use firecrawl_browser_execution_adapter::action_client::AdapterAuthorizationBinding;
use firecrawl_browser_execution_adapter::jobs::{JobKind, JobRegistry};
use firecrawl_browser_execution_adapter::redaction::AdapterErrorCategory;
use uuid::Uuid;

fn binding() -> AdapterAuthorizationBinding {
    AdapterAuthorizationBinding::new(Uuid::new_v4(), Uuid::new_v4(), 7).unwrap()
}

#[test]
fn authorization_and_completion_compare_exact_binding() {
    let registry = JobRegistry::new(1, 2).unwrap();
    let run_id = Uuid::new_v4();
    let expected = binding();
    let admitted = registry.admit(run_id, JobKind::Prompt, expected).unwrap();
    let wrong = binding();
    assert!(registry.authorize(run_id, wrong).is_err());
    registry.authorize(run_id, expected).unwrap();
    registry.begin_start(run_id, expected).unwrap();
    assert!(registry.mark_running(run_id, wrong).is_err());
    registry.mark_running(run_id, expected).unwrap();
    let completion = registry.request_cancel(run_id).unwrap();
    assert!(*admitted.cancellation.borrow());
    assert!(!*completion.borrow());
    assert!(!registry.complete(run_id, wrong, None));
    assert!(registry.complete(run_id, expected, Some(AdapterErrorCategory::Cancelled),));
    assert!(*completion.borrow());
    assert_eq!(registry.active_count(), 0);
}

#[test]
fn start_and_cancel_linearize_under_one_registry_lock() {
    let registry = JobRegistry::new(1, 2).unwrap();

    let cancelled_run = Uuid::new_v4();
    let cancelled = binding();
    registry
        .admit(cancelled_run, JobKind::Prompt, cancelled)
        .unwrap();
    registry.authorize(cancelled_run, cancelled).unwrap();
    let first_completion = registry.request_cancel(cancelled_run).unwrap();
    let repeated_completion = registry.request_cancel(cancelled_run).unwrap();
    assert!(registry.begin_start(cancelled_run, cancelled).is_err());
    assert!(!*first_completion.borrow());
    assert!(!*repeated_completion.borrow());
    assert!(registry.complete(
        cancelled_run,
        cancelled,
        Some(AdapterErrorCategory::Cancelled)
    ));

    let starting_run = Uuid::new_v4();
    let starting = binding();
    registry
        .admit(starting_run, JobKind::Prompt, starting)
        .unwrap();
    registry.authorize(starting_run, starting).unwrap();
    registry.begin_start(starting_run, starting).unwrap();
    registry.request_cancel(starting_run).unwrap();
    assert_eq!(
        registry
            .mark_running(starting_run, starting)
            .unwrap_err()
            .category,
        AdapterErrorCategory::Cancelled
    );
    assert!(registry.complete(
        starting_run,
        starting,
        Some(AdapterErrorCategory::Cancelled)
    ));
}

#[test]
fn terminal_metadata_is_bounded() {
    let registry = JobRegistry::new(1, 2).unwrap();
    for _ in 0..140 {
        let run_id = Uuid::new_v4();
        let binding = binding();
        registry.admit(run_id, JobKind::Prompt, binding).unwrap();
        assert!(registry.complete(run_id, binding, None));
    }
    assert_eq!(registry.terminal_jobs().len(), 128);
}

#[test]
fn preparing_job_reserves_capacity_and_can_be_cancelled_before_binding() {
    let registry = JobRegistry::new(1, 2).unwrap();
    let run_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let supervisor_id = Uuid::new_v4();
    let reserved = registry
        .reserve(run_id, JobKind::Prompt, job_id, supervisor_id)
        .unwrap();
    let second = registry.reserve(
        Uuid::new_v4(),
        JobKind::Prompt,
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    assert_eq!(
        second.unwrap_err().category,
        AdapterErrorCategory::CodexUnavailable
    );

    let completion = registry.request_cancel(run_id).unwrap();
    assert!(*reserved.cancellation.borrow());
    assert!(!*completion.borrow());
    assert!(registry.complete_reserved(run_id, job_id, Some(AdapterErrorCategory::Cancelled)));
    assert!(*completion.borrow());
    assert_eq!(registry.active_count(), 0);
    assert_eq!(
        registry.terminal_jobs(),
        [firecrawl_browser_execution_adapter::jobs::TerminalJob {
            run_id,
            adapter_job_id: job_id,
            category: Some(AdapterErrorCategory::Cancelled),
        }]
    );
}
