# Complexity Red Flags: Extended Examples

## Full Audit Example: E-Commerce Order System

The following code exhibits multiple red flags. We'll identify each one and show the fix.

### The Code Under Review

```typescript
// types/order.ts
interface OrderData {
  id: string;
  items: Array<{ productId: string; quantity: number; price: number }>;
  status: "pending" | "paid" | "shipped" | "cancelled";
  total: number;
}

// validators/order-validator.ts
class OrderValidator {
  validate(data: OrderData): ValidationResult {
    const errors: string[] = [];
    if (!data.items.length) errors.push("Order must have items");
    if (data.total <= 0) errors.push("Total must be positive");
    if (
      data.total !==
      data.items.reduce((sum, i) => sum + i.price * i.quantity, 0)
    ) {
      errors.push("Total does not match items");
    }
    return { valid: errors.length === 0, errors };
  }
}

// repositories/order-repository.ts
class OrderRepository {
  async save(data: OrderData): Promise<void> {
    const row = {
      id: data.id,
      items_json: JSON.stringify(data.items),
      status: data.status,
      total_cents: Math.round(data.total * 100),
    };
    await this.db.insert("orders", row);
  }

  async findById(id: string): Promise<OrderData | null> {
    const row = await this.db.query("orders", { id });
    if (!row) return null;
    return {
      id: row.id,
      items: JSON.parse(row.items_json),
      status: row.status,
      total: row.total_cents / 100,
    };
  }
}

// services/order-service.ts
class OrderService {
  constructor(
    private validator: OrderValidator,
    private repository: OrderRepository,
    private emailService: EmailService,
    private inventoryService: InventoryService,
    private logger: Logger,
  ) {}

  async createOrder(data: OrderData): Promise<OrderData> {
    const validation = this.validator.validate(data);
    if (!validation.valid) throw new ValidationError(validation.errors);
    await this.repository.save(data);
    await this.emailService.sendOrderConfirmation(data);
    return data;
  }

  async getOrder(id: string): Promise<OrderData> {
    const order = await this.repository.findById(id);
    if (!order) throw new NotFoundError("Order not found");
    return order;
  }

  async shipOrder(id: string): Promise<void> {
    const order = await this.getOrder(id);
    if (order.status !== "paid")
      throw new InvalidStateError("Cannot ship unpaid order");
    for (const item of order.items) {
      const available = await this.inventoryService.checkStock(item.productId);
      if (available < item.quantity) {
        throw new InsufficientStockError(item.productId);
      }
    }
    for (const item of order.items) {
      await this.inventoryService.reserve(item.productId, item.quantity);
    }
    order.status = "shipped";
    await this.repository.save(order);
    await this.emailService.sendShippingNotification(order);
  }
}

// controllers/order-controller.ts
class OrderController {
  constructor(private orderService: OrderService) {}

  async create(req: Request): Promise<Response> {
    const order = await this.orderService.createOrder(req.body);
    return Response.json(order, 201);
  }

  async get(req: Request): Promise<Response> {
    const order = await this.orderService.getOrder(req.params.id);
    return Response.json(order);
  }

  async ship(req: Request): Promise<Response> {
    await this.orderService.shipOrder(req.params.id);
    return Response.json({ success: true });
  }
}
```

### Red Flag Audit

#### 1. Shallow Module: `OrderValidator`

One class, one method, validates three things. The interface (import, instantiate, call `validate()`, check `.valid`, read `.errors`) is more ceremony than the 6 lines of actual logic.

**Fix:** Fold validation into the `Order` class itself. An order should know whether it's valid.

#### 2. Shallow Module: `OrderController`

Three methods that do nothing except call the service and wrap the result. Pure pass-through.

**Fix:** If your framework requires a controller layer, at least put error handling, auth checks, or input parsing there. Otherwise, route directly to the service.

#### 3. Information Leakage: Serialization Format

`OrderRepository.save()` knows that the table stores items as JSON (`JSON.stringify(data.items)`) and prices as cents (`Math.round(data.total * 100)`). `OrderRepository.findById()` also knows this (`JSON.parse(row.items_json)`, `row.total_cents / 100`). If you added a `findByStatus()` method, it would need the same knowledge. The JSON-and-cents format leaks into every repository method.

**Fix:** Centralize the mapping in one place:

```typescript
class Order {
  static fromRow(row: DbRow): Order { ... }
  toRow(): DbRow { ... }
}
```

#### 4. Pass-Through Variable: `logger`

`OrderService` takes a `Logger` in its constructor but doesn't use it in any of the shown methods. It likely passes it through for use deeper in the stack.

**Fix:** Use a module-level or context-based logger rather than threading it through constructors.

#### 5. Conjoined Methods: `checkStock` then `reserve`

In `shipOrder`, the code first checks stock for all items, then reserves them, in two loops that depend on each other. If another order reserves stock between the check and the reserve, you get a race condition.

**Fix:** Make `reserve` atomic: it checks and reserves in one step, and returns success or failure:

```typescript
const reserved = await this.inventoryService.reserveAll(order.items);
if (!reserved.ok) {
  // Handle insufficient stock
}
```

#### 6. Excessive Exceptions: `shipOrder`

Throws `InvalidStateError` for wrong status, `InsufficientStockError` for stock issues. Every caller needs to handle these.

**Fix:** Apply "define errors out of existence": `ship()` returns a result that says what happened:

```typescript
async ship(id: string): Promise<ShipResult> {
  // Returns { shipped: true } or { shipped: false, reason: "..." }
}
```

### The Refactored Version

```typescript
class Orders {
  async create(items: OrderItem[]): Promise<Order> {
    const order = Order.create(items); // Validates internally, throws only for bugs
    await this.db.insert(order.toRow());
    await this.notifications.orderCreated(order); // Fire-and-forget internally
    return order;
  }

  async get(id: string): Promise<Order | null> {
    const row = await this.db.query("orders", { id });
    return row ? Order.fromRow(row) : null;
  }

  async ship(id: string): Promise<ShipResult> {
    const order = await this.get(id);
    if (!order || order.status !== "paid") {
      return ShipResult.notShippable(order?.status);
    }

    const reservation = await this.inventory.reserveAll(order.items);
    if (!reservation.ok) {
      return ShipResult.insufficientStock(reservation.unavailable);
    }

    order.markShipped();
    await this.db.update(order.toRow());
    await this.notifications.orderShipped(order);
    return ShipResult.shipped();
  }
}
```

**What changed:**

- 5 classes → 1 deep module (`Orders`) + 1 domain object (`Order`)
- Validator, Controller, and Service eliminated as standalone classes
- DB format mapping centralized in `Order.fromRow()` / `toRow()`
- Stock check + reserve unified into atomic `reserveAll()`
- Exceptions replaced with result types
- Notifications handled internally (fire-and-forget)

---

## Spotting Red Flags in LLM-Generated Code

LLMs tend to produce certain patterns repeatedly. Here's a quick reference for the most common ones:

| What the LLM generates                                       | Red flag                              | What to do instead                             |
| ------------------------------------------------------------ | ------------------------------------- | ---------------------------------------------- |
| `XValidator`, `XFormatter`, `XHelper` one-method classes     | Shallow module                        | Fold into the class that uses them             |
| Controller → Service → Repository with matching method names | Pass-through methods                  | Remove layers that add no logic                |
| `config` or `logger` passed through 4+ function signatures   | Pass-through variables                | Use context, DI container, or module scope     |
| `init()` → `process()` → `finalize()` method sequences       | Conjoined methods                     | Single `process()` that handles lifecycle      |
| `Reader` + `Writer` + `Parser` for the same data             | Temporal decomposition + info leakage | One `DataStore` module                         |
| Constructor with 6+ injected dependencies                    | Overexposure / shallow decomposition  | Fewer, deeper modules need fewer collaborators |
| `if (type === "x")` inside generic processing                | Special-general mixture               | Let callers supply the specialization          |
| `utils/string.ts`, `utils/array.ts` with 1-2 functions each  | Premature abstraction                 | Inline until there's real reuse             |
