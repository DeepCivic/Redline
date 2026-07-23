// @procautomatr/proc-domain — public surface.
//
// Thread 1 establishes only the Result/DomainError primitives. Entities and ports
// (ProcurementResponse, Vendor, ResponseGroup, IntakeStage, IProcurementExtractionReader,
// IProcurementClassifier, IFinancialExtractor, IEvaluationRepository) land in Thread 2.
export * from "./result";
export * from "./errors/domain-error";
