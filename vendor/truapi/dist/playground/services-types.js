/** Services visible to one trusted executable kind. */
export function servicesForExecution(services, execution) {
    return services.filter((service) => service.requiredExecution === undefined ||
        service.requiredExecution === execution);
}
