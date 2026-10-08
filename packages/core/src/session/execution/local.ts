import { Cause, Effect, Layer } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { randomUUID } from "node:crypto"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const owners = new Map<SessionSchema.ID, SessionStatusEvent.Owner>()
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        const runEpoch = randomUUID()
        return yield* SessionRunner.Service.use((runner) =>
          runner.run({
            sessionID,
            force,
            runEpoch,
            onOwnership: (owner) =>
              Effect.sync(() => {
                if (owner) owners.set(sessionID, { ...owner, runEpoch })
                if (!owner) owners.delete(sessionID)
              }),
          }),
        ).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.ensuring(Effect.sync(() => owners.delete(sessionID))),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      ownership: Effect.sync(() => new Map(owners)),
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node],
})

export * as SessionExecutionLocal from "./local"
