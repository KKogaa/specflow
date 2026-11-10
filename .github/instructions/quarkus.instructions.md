---
applyTo: "**/*.java,**/application.properties,**/pom.xml"
description: Quarkus backend coding standards, used when the backend is Java + Quarkus.
---

# Coding standards: Quarkus (Java backend)

Use these only if `## Project` in `AGENTS.md` says the backend is Java + Quarkus. Stack: Quarkus 3 with Maven, Quarkus REST + Jackson, Hibernate Validator, Hibernate ORM with Panache, Flyway, SmallRye OpenAPI and Fault Tolerance, JUnit 5 with RestAssured. Use the versions `scaffold` put in `pom.xml`.

## Commands

- Run Maven through the wrapper (`./mvnw`), wrapped in the root `package.json` scripts the Commands table uses (e.g. `"test:api": "cd api && ./mvnw -q test"`), so every row of the table is one short command.
- Dev Services start databases in Docker. If a machine has no Docker, `%dev` and `%test` profiles use a hosted database or H2, set in `application.properties`, so `check` still passes.

## Architecture in Quarkus

The architecture is pragmatic hexagonal (`backend-architecture.instructions.md`). In Quarkus:

- Packages per feature: `…items.domain`, `…items.application`, `…items.adapters.http`, `…items.adapters.persistence`, `…items.adapters.<service>`.
- `domain` is plain Java: records and classes with no Quarkus, Jakarta or Hibernate annotations.
- Use cases are `@ApplicationScoped` classes in `application` (`CreateItem` with one public `execute(...)` method), injected through the constructor. They own `@Transactional`.
- Ports are Java interfaces in `application` (`ItemRepository`). Adapters are `@ApplicationScoped` beans that implement them. CDI is the composition root: there's exactly one bean per port in each profile, so no qualifiers are needed. Test doubles are `@Alternative` or `@InjectMock` beans.

## REST resources and the Contracts

- One resource class per feature in `adapters.http` (`ItemResource`), `@Path` matching `design.md` exactly. Resources stay thin: validate, map the request to the use case input, call the use case, map the result to a response DTO.
- Request and response DTOs are records in `adapters.http`. Never return JPA entities or domain objects directly.
- Plain (blocking) return types: Quarkus runs them on a worker thread. Don't use Mutiny or `@NonBlocking` unless the issue needs it.
- Return `RestResponse<T>` (or `Response`) only when the status isn't the default, e.g. 201 with the created DTO.
- `@Valid` on request bodies, Bean Validation annotations on the record's components (`@NotBlank`, `@Size`, `@Positive`).
- SmallRye OpenAPI generates `/q/openapi` from the code. It must match the Contracts: the frontend generates its types from it (`openapi-typescript`), so an annotation mistake breaks the frontend.

## Errors

- One `@ServerExceptionMapper` class maps exceptions to the documented error shape: `ConstraintViolationException` to 400 with field details, domain exceptions (`NotFound…`, `Conflict…`) to their status, anything else to 500 with a generic message, logged with the cause.
- Use cases throw domain exceptions (no HTTP status in them). Resources never build error responses themselves.

## CDI and config

- Use cases and adapters are `@ApplicationScoped`. Inject through the constructor, or package-private fields with `@Inject`. No private-field injection (it forces reflection), no `new` of beans.
- Config with `@ConfigMapping` interfaces, grouped by feature, not scattered `@ConfigProperty`. Secrets come from env vars (`QUARKUS_…` or `${MY_API_KEY}` in `application.properties`), listed in `.env.example`.
- Profiles: `%dev.`, `%test.` and `%prod.` prefixes in one `application.properties`.
- Log with `io.quarkus.logging.Log` (`Log.infof("created item %s", id)`). No `System.out`.

## Data

- Hibernate ORM with Panache lives in `adapters.persistence`: a JPA entity (`ItemEntity`), a `PanacheRepository<ItemEntity>`, and the adapter that implements the domain's `ItemRepository` port and maps entity to domain. Entities never leave the adapter. Transactions are on the use case.
- Schema changes are Flyway migrations (`db/migration/V2__add_status.sql`), never `drop-and-create` outside tests. Seed data is a migration or an `%dev` import script.

## External calls (LLM, third-party APIs)

- A `@RegisterRestClient` interface per service in `adapters.<service>`, its URL and timeouts in config (`quarkus.rest-client.<name>.read-timeout`), wrapped by the adapter bean that implements the port.
- `@Timeout` and `@Fallback` (SmallRye Fault Tolerance) on the adapter method that calls it. On the demo path (`priority:p0`), the fallback returns a deterministic response.

## Tests

- **Use cases:** plain JUnit 5 tests, no `@QuarkusTest`: construct the use case with in-memory adapters. Most WHEN/THEN scenarios are tested here, in milliseconds.
- **Resources:** `@QuarkusTest` with RestAssured against the real endpoints: assert the status and the body fields from the Contracts.
- Replace external clients with `@InjectMock` (quarkus-junit5-mockito) or a `@Mock` alternative bean. Tests never hit the network.
- One test per WHEN/THEN scenario, plus a 400 for each endpoint that takes input.
