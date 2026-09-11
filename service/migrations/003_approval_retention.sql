-- Documents a deliberate choice rather than changing behaviour: approval rows
-- are retained even after their subject is gone, and this is not an oversight.
--
-- `approval.subject_id` is polymorphic (criterion or test_case, per
-- subject_type) so it cannot carry a foreign key, and nothing in this schema
-- cascades a delete into it. A criterion trimmed by a redraft, or deleted via
-- a project's ON DELETE CASCADE, leaves its approval rows behind.
--
-- That is correct, not a leak: an approval is a historical record of a
-- decision someone made, at a hash, at a time - the same category of fact as
-- an audit_event row, which is append-only for exactly this reason. Deleting
-- it when its subject disappears would let a redraft (or worse, a project
-- deletion) quietly erase the fact that a PO or developer once approved
-- something, which is precisely the record spec2test exists to keep.
--
-- The consequence for anyone querying this table: always scope by subject_id
-- or a joined requirement/project, never assume a row count reflects only
-- "live" subjects. approval_subject_idx (migration 001) is built for that
-- scoped access pattern already.
COMMENT ON TABLE approval IS
    'Append-in-spirit decision history. Rows are retained after their subject '
    '(criterion or test_case) is deleted - deliberate, see migration 003. '
    'Always query scoped by subject_id or a joined requirement, never as a '
    'bare global count.';

COMMENT ON COLUMN approval.subject_id IS
    'Polymorphic: a criterion.id or test_case.id per subject_type. No FK by '
    'necessity, and rows are not cleaned up when the subject is deleted - '
    'that retention is intentional, not an oversight. See migration 003.';
