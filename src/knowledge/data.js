// Public Knowledge Base - Educational theory and reference content
// Purely public, read-only educational material for developers and learners.

import {
  loadAllConcepts,
  getConceptArticles,
  getConceptArticlesByCategory,
  getConceptArticle
} from './loader.js';

export const CATEGORIES = [
  {
    slug: 'java',
    name: 'Java Concepts',
    tagline: 'Core Java, Object-Oriented Programming, Collections, Concurrency & JVM',
    description: 'Comprehensive tutorials and technical reference on core Java concepts, object-oriented design, memory management, multithreading, and the Collections framework.',
    icon: '☕',
    color: '#b07219'
  },
  {
    slug: 'sql',
    name: 'SQL & Databases',
    tagline: 'Relational Theory, Queries, Joins, Window Functions, Indexing & Transactions',
    description: 'In-depth reference covering relational database principles, complex SQL queries, query execution plans, indexing strategies, ACID guarantees, and database normalization.',
    icon: '🗄️',
    color: '#336791'
  },
  {
    slug: 'programming-concepts',
    name: 'Programming & System Design',
    tagline: 'SOLID Principles, Design Patterns, Algorithms, Data Structures & REST APIs',
    description: 'Foundational software engineering theory, design patterns, algorithmic complexity, clean architecture, and modern API standards.',
    icon: '🧩',
    color: '#7c3aed'
  },
  {
    slug: 'guidewire-theory',
    name: 'Guidewire Architecture & Gosu',
    tagline: 'InsuranceSuite Architecture, Gosu Language, Data Model, PCF & Bundles',
    description: 'Conceptual theory and architectural guides for Guidewire InsuranceSuite (PolicyCenter, ClaimCenter, BillingCenter), the Gosu programming language, and database bundle transactions.',
    icon: '⚡',
    color: '#0284c7'
  },
  {
    slug: 'insurance',
    name: 'Insurance Principles',
    tagline: 'Property & Casualty, Risk Transfer, Policy Contracts, Underwriting & Claims',
    description: 'Educational reference on property & casualty insurance fundamentals, policy terms, indemnification, loss ratios, and claims handling.',
    icon: '🛡️',
    color: '#059669'
  }
];

export const ARTICLES = [
  // ==========================================
  // JAVA CONCEPTS
  // ==========================================
  {
    slug: 'java-oop-principles',
    category: 'java',
    categoryName: 'Java Concepts',
    title: 'Object-Oriented Programming (OOP) in Java: The Four Pillars',
    description: 'Master Encapsulation, Inheritance, Polymorphism, and Abstraction in Java with real-world examples, memory implications, and architectural best practices.',
    readTime: '8 min read',
    lastUpdated: '2026-03-01',
    tags: ['Java', 'OOP', 'Inheritance', 'Polymorphism', 'Abstraction', 'Encapsulation'],
    summary: 'Object-Oriented Programming is the foundational paradigm of Java. This guide covers the four fundamental pillars—Encapsulation, Abstraction, Inheritance, and Polymorphism—explaining how they enable maintainable, scalable enterprise software.',
    tableOfContents: [
      { id: 'encapsulation', title: '1. Encapsulation & Data Hiding' },
      { id: 'abstraction', title: '2. Abstraction: Interfaces vs Abstract Classes' },
      { id: 'inheritance', title: '3. Inheritance & The IS-A Relationship' },
      { id: 'polymorphism', title: '4. Polymorphism: Compile-Time vs Runtime' },
      { id: 'summary-matrix', title: '5. Summary Comparison Matrix' }
    ],
    sections: [
      {
        id: 'encapsulation',
        heading: '1. Encapsulation & Data Hiding',
        content: `
          <p><strong>Encapsulation</strong> is the bundling of data (fields) and methods that operate on that data into a single unit (a class), while restricting direct access to some of the object's components. In Java, this is achieved using access modifiers (<code>private</code>, <code>protected</code>, <code>public</code>, and package-private) alongside getter and setter methods.</p>
          <div class="code-block-wrapper">
            <pre><code class="language-java">// Encapsulation Example
public class BankAccount {
    private String accountNumber;
    private double balance;

    public BankAccount(String accountNumber, double initialBalance) {
        this.accountNumber = accountNumber;
        if (initialBalance >= 0) {
            this.balance = initialBalance;
        } else {
            throw new IllegalArgumentException("Initial balance cannot be negative");
        }
    }

    public double getBalance() {
        return balance;
    }

    public synchronized void deposit(double amount) {
        if (amount > 0) {
            this.balance += amount;
        } else {
            throw new IllegalArgumentException("Deposit amount must be positive");
        }
    }
}</code></pre>
          </div>
          <p><strong>Key Benefits:</strong></p>
          <ul>
            <li><strong>Invariant Enforcement:</strong> Business rules (like preventing negative balances) are guaranteed at all times.</li>
            <li><strong>Loose Coupling:</strong> Internal representation can change without breaking client code that depends on public accessors.</li>
            <li><strong>Thread Safety:</strong> Synchronization can be encapsulated around state mutations.</li>
          </ul>
        `
      },
      {
        id: 'abstraction',
        heading: '2. Abstraction: Interfaces vs Abstract Classes',
        content: `
          <p><strong>Abstraction</strong> is the process of hiding implementation details and exposing only the essential interface to the user. A caller knows <em>what</em> an object does, not <em>how</em> it executes internally.</p>
          <p>In Java, abstraction is modeled via <strong>Interfaces</strong> (pure contract) and <strong>Abstract Classes</strong> (partial contract with shared state or behavior):</p>
          <div class="code-block-wrapper">
            <pre><code class="language-java">// Interface: defines capability contract
public interface PaymentProcessor {
    PaymentResult process(PaymentRequest request);
}

// Abstract Class: provides skeletal implementation
public abstract class AbstractPaymentProcessor implements PaymentProcessor {
    protected void logTransaction(PaymentRequest req) {
        System.out.println("Processing payment for: " + req.getCustomerId());
    }

    @Override
    public final PaymentResult process(PaymentRequest request) {
        validate(request);
        logTransaction(request);
        return doProcess(request); // Template Method pattern
    }

    protected abstract void validate(PaymentRequest req);
    protected abstract PaymentResult doProcess(PaymentRequest req);
}</code></pre>
          </div>
          <p><strong>When to use which:</strong> Use an interface when you want to define a role or capability across unrelated classes (e.g. <code>Comparable</code>, <code>Runnable</code>). Use an abstract class when you want to share state, constructors, or non-public methods across closely related classes in an inheritance hierarchy.</p>
        `
      },
      {
        id: 'inheritance',
        heading: '3. Inheritance & The IS-A Relationship',
        content: `
          <p><strong>Inheritance</strong> allows a new class (subclass) to inherit attributes and methods from an existing class (superclass). In Java, classes use the <code>extends</code> keyword and support single class inheritance to avoid the diamond problem of multiple inheritance.</p>
          <div class="code-block-wrapper">
            <pre><code class="language-java">public class Vehicle {
    protected int maxSpeed;

    public Vehicle(int maxSpeed) {
        this.maxSpeed = maxSpeed;
    }

    public void start() {
        System.out.println("Vehicle started.");
    }
}

public class ElectricCar extends Vehicle {
    private int batteryCapacityKWh;

    public ElectricCar(int maxSpeed, int batteryCapacityKWh) {
        super(maxSpeed);
        this.batteryCapacityKWh = batteryCapacityKWh;
    }

    @Override
    public void start() {
        System.out.println("Electric motor engaged silently.");
    }
}</code></pre>
          </div>
          <p><strong>Best Practice:</strong> <em>Favor composition over inheritance</em> when an IS-A relationship does not hold strictly throughout the software lifecycle. Inheritance creates tight coupling between parent and child classes.</p>
        `
      },
      {
        id: 'polymorphism',
        heading: '4. Polymorphism: Compile-Time vs Runtime',
        content: `
          <p><strong>Polymorphism</strong> ("many forms") enables a single interface to represent different underlying types.</p>
          <p>Java supports two distinct forms of polymorphism:</p>
          <ol>
            <li><strong>Compile-time Polymorphism (Method Overloading):</strong> Multiple methods in the same class share the same name but have different parameter lists (types, counts, or orders). Resolved at compile time.</li>
            <li><strong>Runtime Polymorphism (Method Overriding & Dynamic Method Dispatch):</strong> A subclass provides a specific implementation of a method defined in its superclass. Resolved dynamically at runtime using the JVM's Virtual Method Table (vtable).</li>
          </ol>
          <div class="code-block-wrapper">
            <pre><code class="language-java">// Runtime Dynamic Dispatch
List&lt;PaymentProcessor&gt; processors = List.of(
    new CreditCardProcessor(),
    new UpiPaymentProcessor(),
    new CryptoPaymentProcessor()
);

for (PaymentProcessor p : processors) {
    p.process(request); // Dispatched at runtime to the specific implementation
}</code></pre>
          </div>
        `
      },
      {
        id: 'summary-matrix',
        heading: '5. Summary Comparison Matrix',
        content: `
          <div class="table-responsive">
            <table class="concept-table">
              <thead>
                <tr>
                  <th>Pillar</th>
                  <th>Primary Mechanism in Java</th>
                  <th>Core Benefit</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>Encapsulation</strong></td>
                  <td>Access modifiers (<code>private</code>), accessors, mutators</td>
                  <td>Guarantees data integrity and prevents invalid state transitions.</td>
                </tr>
                <tr>
                  <td><strong>Abstraction</strong></td>
                  <td><code>interface</code>, <code>abstract class</code></td>
                  <td>Reduces cognitive complexity by decoupling interface from implementation.</td>
                </tr>
                <tr>
                  <td><strong>Inheritance</strong></td>
                  <td><code>extends</code>, <code>super</code></td>
                  <td>Enables code reuse and establishes IS-A classification hierarchies.</td>
                </tr>
                <tr>
                  <td><strong>Polymorphism</strong></td>
                  <td><code>@Override</code> (dynamic dispatch), method overloading</td>
                  <td>Allows writing flexible, pluggable code that operates on abstract types.</td>
                </tr>
              </tbody>
            </table>
          </div>
        `
      }
    ]
  },
  {
    slug: 'java-collections-framework',
    category: 'java',
    categoryName: 'Java Concepts',
    title: 'Java Collections Framework: Deep Dive & Internal Mechanics',
    description: 'Understand the internals of ArrayList, LinkedList, HashMap, HashSet, and ConcurrentHashMap, including hashing collisions, load factors, and Big-O complexities.',
    readTime: '10 min read',
    lastUpdated: '2026-03-01',
    tags: ['Java', 'Collections', 'HashMap', 'ArrayList', 'Data Structures'],
    summary: 'The Java Collections Framework (JCF) provides standard architecture for representing and manipulating collections. This guide examines how the fundamental collection types function under the hood.',
    tableOfContents: [
      { id: 'hierarchy', title: '1. JCF Interface Hierarchy' },
      { id: 'lists', title: '2. List Implementations: ArrayList vs LinkedList' },
      { id: 'hashmap-internals', title: '3. HashMap Internals: Buckets, Collisions, and Red-Black Trees' },
      { id: 'sets-queues', title: '4. Set and Queue Implementations' },
      { id: 'concurrency', title: '5. Concurrent Collections vs Synchronized Wrappers' }
    ],
    sections: [
      {
        id: 'hierarchy',
        heading: '1. JCF Interface Hierarchy',
        content: `
          <p>The root interface of the collection hierarchy is <code>java.util.Collection</code>, which is extended by <code>List</code>, <code>Set</code>, and <code>Queue</code>. Notably, <strong><code>Map</code> is not a subtype of Collection</strong> because key-value mappings have distinct semantics from value-only collections.</p>
        `
      },
      {
        id: 'lists',
        heading: '2. List Implementations: ArrayList vs LinkedList',
        content: `
          <p>Both implement <code>List</code>, but their performance profiles differ dramatically due to memory layout:</p>
          <ul>
            <li><strong>ArrayList:</strong> Backed by a contiguous array. Random access (<code>get(index)</code>) is <strong>O(1)</strong>. Appending is amortized <strong>O(1)</strong>, but resizing triggers a new array allocation with 1.5x capacity and a copy via <code>System.arraycopy</code>. Insertions or removals at arbitrary indices require shifting elements, yielding <strong>O(n)</strong>.</li>
            <li><strong>LinkedList:</strong> A doubly-linked list. Element access is <strong>O(n)</strong> because it requires traversal from head or tail. Insertion or deletion once the node is located is <strong>O(1)</strong>. However, due to pointer overhead (each node requires 24+ bytes for object header, previous pointer, next pointer, and data reference) and poor CPU cache locality, <strong>ArrayList almost always outperforms LinkedList</strong> in modern JVMs.</li>
          </ul>
        `
      },
      {
        id: 'hashmap-internals',
        heading: '3. HashMap Internals: Buckets, Collisions, and Red-Black Trees',
        content: `
          <p>A Java <code>HashMap</code> stores key-value pairs using an array of <code>Node&lt;K,V&gt;</code> buckets. Understanding its mechanics is essential for system performance:</p>
          <ol>
            <li><strong>Hash Calculation:</strong> The key's <code>hashCode()</code> is passed through a bitwise spreading function: <code>(h = key.hashCode()) ^ (h >>> 16)</code>. This ensures high-order bits affect low-order index calculations.</li>
            <li><strong>Index Formula:</strong> The bucket index is calculated via bitwise AND: <code>index = (n - 1) & hash</code>, where <code>n</code> is always a power of two.</li>
            <li><strong>Collision Handling (Java 8+):</strong> When two keys hash to the same bucket:
              <ul>
                <li>Initially, entries are chained as a singly-linked list.</li>
                <li>When a bucket's length exceeds <strong>TREEIFY_THRESHOLD = 8</strong> and the total table capacity is at least 64, the linked list is converted into a balanced <strong>Red-Black Tree (TreeNode)</strong>.</li>
                <li>This bounds worst-case lookup from <strong>O(n)</strong> down to <strong>O(log n)</strong>, protecting against hash-flooding DoS attacks.</li>
              </ul>
            </li>
            <li><strong>Rehashing:</strong> When entries exceed <code>capacity * loadFactor</code> (default 16 * 0.75 = 12 entries), the table doubles in size, and elements are redistributed.</li>
          </ol>
        `
      },
      {
        id: 'sets-queues',
        heading: '4. Set and Queue Implementations',
        content: `
          <p><strong>HashSet</strong> is internally implemented using a backing <code>HashMap</code> where the set elements serve as map keys, and a dummy <code>Object PRESENT</code> serves as the value. Consequently, <code>add()</code>, <code>remove()</code>, and <code>contains()</code> operations share the same O(1) characteristics as HashMap.</p>
          <p><strong>TreeSet</strong> is backed by a <code>NavigableMap</code> (specifically <code>TreeMap</code>), maintaining keys sorted in natural order or according to a specified <code>Comparator</code> with <strong>O(log n)</strong> operations.</p>
        `
      },
      {
        id: 'concurrency',
        heading: '5. Concurrent Collections vs Synchronized Wrappers',
        content: `
          <p>Legacy synchronization (such as <code>Collections.synchronizedMap()</code> or <code>Hashtable</code>) locks the entire map on every read and write operation, causing severe thread contention.</p>
          <p>Modern concurrent programming relies on <strong><code>ConcurrentHashMap</code></strong>:</p>
          <ul>
            <li>In Java 8+, it uses fine-grained bucket-level synchronization: non-blocking volatile reads, and synchronization locks only on the individual bucket's first node during writes.</li>
            <li>Multiple reader threads can read concurrently without blocking writers.</li>
            <li>It never throws <code>ConcurrentModificationException</code> during iteration.</li>
          </ul>
        `
      }
    ]
  },
  {
    slug: 'java-multithreading-concurrency',
    category: 'java',
    categoryName: 'Java Concepts',
    title: 'Java Concurrency & Multithreading: Principles to Advanced Coordination',
    description: 'Learn the Java Memory Model, volatile, synchronized, locks, thread pools, ExecutorService, and modern concurrency coordination utilities.',
    readTime: '11 min read',
    lastUpdated: '2026-03-01',
    tags: ['Java', 'Concurrency', 'Threads', 'ExecutorService', 'JMM'],
    summary: 'Multithreading allows multiple execution paths within a single JVM process. Mastering thread lifecycles, memory visibility, and non-blocking constructs is critical for building responsive enterprise systems.',
    tableOfContents: [
      { id: 'jmm-visibility', title: '1. The Java Memory Model & Visibility' },
      { id: 'synchronization', title: '2. synchronized vs ReentrantLock' },
      { id: 'executors', title: '3. Thread Pools & ExecutorService' },
      { id: 'futures', title: '4. CompletableFuture & Async Pipelines' }
    ],
    sections: [
      {
        id: 'jmm-visibility',
        heading: '1. The Java Memory Model & Visibility',
        content: `
          <p>In modern multi-core processors, each CPU core has its own L1/L2/L3 hardware caches. Without memory barriers, a write by Thread A on Core 1 may remain in Core 1's local cache and remain invisible to Thread B reading on Core 2.</p>
          <p>The <strong>Java Memory Model (JMM)</strong> defines the <em>happens-before</em> relationship that guarantees when one action is visible to another:</p>
          <ul>
            <li><strong><code>volatile</code>:</strong> Instructs the compiler and CPU not to cache the variable in CPU registers. Every read fetches from main memory, and every write immediately flushes to main memory. It prevents instruction reordering around the variable. Note: <code>volatile</code> guarantees <em>visibility</em>, not <em>atomicity</em> (e.g. <code>count++</code> is still not thread-safe).</li>
            <li><strong>Atomic Variables:</strong> Classes in <code>java.util.concurrent.atomic</code> (e.g., <code>AtomicInteger</code>, <code>AtomicReference</code>) use hardware-level <strong>Compare-And-Swap (CAS)</strong> instructions to achieve lock-free thread-safe updates.</li>
          </ul>
        `
      },
      {
        id: 'synchronization',
        heading: '2. synchronized vs ReentrantLock',
        content: `
          <div class="table-responsive">
            <table class="concept-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th><code>synchronized</code> Block</th>
                  <th><code>ReentrantLock</code></th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Lock Acquisition</td>
                  <td>Implicit, structured (tied to scope)</td>
                  <td>Explicit via <code>lock()</code> / <code>unlock()</code></td>
                </tr>
                <tr>
                  <td>Timeouts</td>
                  <td>Cannot timeout (blocks indefinitely)</td>
                  <td>Supported via <code>tryLock(timeout, unit)</code></td>
                </tr>
                <tr>
                  <td>Fairness</td>
                  <td>Non-fair only</td>
                  <td>Configurable fair or non-fair policy</td>
                </tr>
                <tr>
                  <td>Multiple Conditions</td>
                  <td>Single wait-set per monitor</td>
                  <td>Multiple <code>Condition</code> instances supported</td>
                </tr>
              </tbody>
            </table>
          </div>
        `
      },
      {
        id: 'executors',
        heading: '3. Thread Pools & ExecutorService',
        content: `
          <p>Creating raw OS threads (<code>new Thread()</code>) incurs heavy overhead (~1MB stack space per thread, OS context switching cost). In production, tasks must be dispatched through an <strong>ExecutorService</strong>:</p>
          <div class="code-block-wrapper">
            <pre><code class="language-java">// Production-ready ThreadPoolExecutor configuration
int cores = Runtime.getRuntime().availableProcessors();
ThreadPoolExecutor executor = new ThreadPoolExecutor(
    cores,                     // Core pool size
    cores * 2,                 // Max pool size
    60L, TimeUnit.SECONDS,     // Idle thread keep-alive
    new ArrayBlockingQueue<>(500), // Bounded task queue
    new ThreadFactoryBuilder().setNameFormat("worker-%d").build(),
    new ThreadPoolExecutor.CallerRunsPolicy() // Backpressure handler
);</code></pre>
          </div>
          <p><strong>Rule of Thumb:</strong> Always use a <strong>bounded queue</strong> (like <code>ArrayBlockingQueue</code>) instead of an unbounded queue (<code>LinkedBlockingQueue</code> without size) to prevent <code>OutOfMemoryError</code> under traffic spikes.</p>
        `
      },
      {
        id: 'futures',
        heading: '4. CompletableFuture & Async Pipelines',
        content: `
          <p>Introduced in Java 8, <code>CompletableFuture</code> provides non-blocking asynchronous programming, enabling chaining, combining, and error handling for asynchronous tasks:</p>
          <div class="code-block-wrapper">
            <pre><code class="language-java">CompletableFuture.supplyAsync(() -&gt; fetchUser(userId), executor)
    .thenCompose(user -&gt; fetchUserPermissions(user))
    .thenApply(perms -&gt; buildSecurityToken(perms))
    .exceptionally(ex -&gt; {
        log.error("Failed to build token", ex);
        return SecurityToken.anonymous();
    });</code></pre>
          </div>
        `
      }
    ]
  },

  // ==========================================
  // SQL CONCEPTS
  // ==========================================
  {
    slug: 'sql-joins-deep-dive',
    category: 'sql',
    categoryName: 'SQL & Databases',
    title: 'SQL Joins Deep Dive: Inner, Outer, Cross, and Self Joins',
    description: 'Master relational algebra joins, understand join execution algorithms (Nested Loop, Hash Join, Merge Join), and avoid common NULL traps.',
    readTime: '9 min read',
    lastUpdated: '2026-03-01',
    tags: ['SQL', 'Joins', 'Relational Database', 'PostgreSQL', 'Query Performance'],
    summary: 'Joins allow you to correlate records from multiple relational tables based on logical predicates. This guide details every join variety, how database engines execute them, and how to avoid subtle NULL mistakes.',
    tableOfContents: [
      { id: 'join-types', title: '1. Standard Join Types Overview' },
      { id: 'execution-algorithms', title: '2. Under the Hood: Join Algorithms' },
      { id: 'null-gotchas', title: '3. Common Pitfalls: The ON vs WHERE Clause Filter' },
      { id: 'cross-self-joins', title: '4. Self Joins & Cross Joins' }
    ],
    sections: [
      {
        id: 'join-types',
        heading: '1. Standard Join Types Overview',
        content: `
          <p>Relational databases operate on relational algebra. When two sets are combined:</p>
          <ul>
            <li><strong>INNER JOIN:</strong> Returns only rows where there is a match in <em>both</em> tables according to the join condition.</li>
            <li><strong>LEFT OUTER JOIN:</strong> Returns all rows from the left table, and matched rows from the right table. Where no match exists, NULLs fill the right-table columns.</li>
            <li><strong>RIGHT OUTER JOIN:</strong> Returns all rows from the right table, and matched rows from the left table.</li>
            <li><strong>FULL OUTER JOIN:</strong> Returns rows when there is a match in either table; unfilled sides are populated with NULLs.</li>
          </ul>
          <div class="code-block-wrapper">
            <pre><code class="language-sql">-- Practical Example: Orders with Customer Details
SELECT 
    c.customer_id,
    c.customer_name,
    o.order_id,
    o.order_date,
    COALESCE(o.total_amount, 0.00) AS total_amount
FROM customers c
LEFT JOIN orders o 
    ON c.customer_id = o.customer_id
   AND o.status = 'COMPLETED';</code></pre>
          </div>
        `
      },
      {
        id: 'execution-algorithms',
        heading: '2. Under the Hood: Join Algorithms',
        content: `
          <p>When you submit a SQL query, the query planner chooses an physical execution algorithm based on table statistics and available indexes:</p>
          <ol>
            <li><strong>Nested Loop Join:</strong> For each row in the outer table, scans the inner table (ideally via an index scan). Highly efficient when the outer dataset is small and the inner dataset has an index on the join key.</li>
            <li><strong>Hash Join:</strong> Scans the smaller table and builds an in-memory hash table on the join key. Then scans the larger table and probes the hash table. Best for large, unsorted datasets without relevant indexes.</li>
            <li><strong>Merge Join (Sort-Merge):</strong> Both datasets are sorted by the join key, and then scanned concurrently in lockstep. Extremely efficient when inputs are already sorted by an index.</li>
          </ol>
        `
      },
      {
        id: 'null-gotchas',
        heading: '3. Common Pitfalls: The ON vs WHERE Clause Filter',
        content: `
          <p>One of the most frequent bugs in SQL queries occurs when placing a filter on a LEFT JOINed table in the <code>WHERE</code> clause instead of the <code>ON</code> clause:</p>
          <div class="code-block-wrapper">
            <pre><code class="language-sql">-- ❌ INCORRECT: Converts the LEFT JOIN into an INNER JOIN!
SELECT c.name, o.order_id
FROM customers c
LEFT JOIN orders o ON c.id = o.customer_id
WHERE o.order_date &gt;= '2026-01-01';
-- Because non-matching customers produce NULL for o.order_date, 
-- and NULL &gt;= '2026-01-01' evaluates to UNKNOWN (filtered out),
-- all customers without orders are discarded!

-- ✅ CORRECT: Preserves all customers regardless of order history
SELECT c.name, o.order_id
FROM customers c
LEFT JOIN orders o ON c.id = o.customer_id 
                  AND o.order_date &gt;= '2026-01-01';</code></pre>
          </div>
        `
      },
      {
        id: 'cross-self-joins',
        heading: '4. Self Joins & Cross Joins',
        content: `
          <p><strong>Self Join:</strong> Joining a table to itself. Useful for hierarchical relationships (e.g. employees and their managers):</p>
          <div class="code-block-wrapper">
            <pre><code class="language-sql">SELECT 
    e.employee_name AS Employee,
    m.employee_name AS Manager
FROM employees e
LEFT JOIN employees m ON e.manager_id = m.employee_id;</code></pre>
          </div>
          <p><strong>CROSS JOIN:</strong> Produces the Cartesian product (M × N rows). Useful for generating dates, combinations, or matrix reporting tables.</p>
        `
      }
    ]
  },
  {
    slug: 'sql-window-functions',
    category: 'sql',
    categoryName: 'SQL & Databases',
    title: 'SQL Window Functions: ROW_NUMBER, RANK, DENSE_RANK, and Beyond',
    description: 'Learn how to calculate running totals, moving averages, top-N per group, and lag/lead differences without collapsing rows into aggregates.',
    readTime: '9 min read',
    lastUpdated: '2026-03-01',
    tags: ['SQL', 'Window Functions', 'Analytics', 'Ranking', 'PostgreSQL'],
    summary: 'Window functions perform calculations across a set of table rows related to the current row without collapsing them into a single output row like GROUP BY does.',
    tableOfContents: [
      { id: 'window-vs-aggregate', title: '1. Window Functions vs GROUP BY' },
      { id: 'ranking-functions', title: '2. Ranking: ROW_NUMBER vs RANK vs DENSE_RANK' },
      { id: 'value-functions', title: '3. Navigation Functions: LAG and LEAD' },
      { id: 'running-totals', title: '4. Running Aggregates & Frame Specifications' }
    ],
    sections: [
      {
        id: 'window-vs-aggregate',
        heading: '1. Window Functions vs GROUP BY',
        content: `
          <p>Unlike standard aggregate functions with <code>GROUP BY</code> that condense multiple rows into a single summary row, <strong>window functions</strong> retain every original row while appending calculated analytics.</p>
          <p>The core syntax follows the pattern:</p>
          <div class="code-block-wrapper">
            <pre><code class="language-sql">FUNCTION_NAME() OVER (
    PARTITION BY column1 
    ORDER BY column2 [ASC|DESC]
    [ROWS|RANGE frame_specification]
)</code></pre>
          </div>
        `
      },
      {
        id: 'ranking-functions',
        heading: '2. Ranking: ROW_NUMBER vs RANK vs DENSE_RANK',
        content: `
          <p>Understanding how ranking functions handle ties is essential for Top-N per group problems:</p>
          <ul>
            <li><strong><code>ROW_NUMBER()</code>:</strong> Assigns a unique sequential integer (1, 2, 3, 4) to each row within a partition, breaking ties deterministically or arbitrarily.</li>
            <li><strong><code>RANK()</code>:</strong> Assigns the same rank to identical values, but <em>skips</em> subsequent ranks (1, 2, 2, 4).</li>
            <li><strong><code>DENSE_RANK()</code>:</strong> Assigns the same rank to identical values, but <em>never skips</em> subsequent ranks (1, 2, 2, 3).</li>
          </ul>
          <div class="code-block-wrapper">
            <pre><code class="language-sql">-- Top 3 highest earning employees per department
WITH RankedEmployees AS (
    SELECT 
        employee_id,
        department_id,
        salary,
        DENSE_RANK() OVER (
            PARTITION BY department_id 
            ORDER BY salary DESC
        ) AS rank_in_dept
    FROM employees
)
SELECT * 
FROM RankedEmployees
WHERE rank_in_dept &lt;= 3;</code></pre>
          </div>
        `
      },
      {
        id: 'value-functions',
        heading: '3. Navigation Functions: LAG and LEAD',
        content: `
          <p><strong><code>LAG(column, offset, default)</code></strong> accesses data from a preceding row in the window, while <strong><code>LEAD()</code></strong> accesses data from a subsequent row without requiring self-joins:</p>
          <div class="code-block-wrapper">
            <pre><code class="language-sql">-- Calculate Month-over-Month Revenue Growth
SELECT 
    revenue_month,
    monthly_revenue,
    LAG(monthly_revenue, 1) OVER (ORDER BY revenue_month) AS prev_month_revenue,
    monthly_revenue - LAG(monthly_revenue, 1) OVER (ORDER BY revenue_month) AS mom_difference,
    ROUND(
        100.0 * (monthly_revenue - LAG(monthly_revenue, 1) OVER (ORDER BY revenue_month)) / 
        LAG(monthly_revenue, 1) OVER (ORDER BY revenue_month), 
        2
    ) AS mom_growth_pct
FROM monthly_sales;</code></pre>
          </div>
        `
      },
      {
        id: 'running-totals',
        heading: '4. Running Aggregates & Frame Specifications',
        content: `
          <p>When you supply an <code>ORDER BY</code> inside an <code>OVER()</code> clause for an aggregate function like <code>SUM()</code>, the default frame is <code>RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW</code>, creating a cumulative running total:</p>
          <div class="code-block-wrapper">
            <pre><code class="language-sql">SELECT 
    transaction_date,
    amount,
    SUM(amount) OVER (
        ORDER BY transaction_date 
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS running_balance
FROM transactions;</code></pre>
          </div>
        `
      }
    ]
  },
  {
    slug: 'sql-transactions-acid-isolation',
    category: 'sql',
    categoryName: 'SQL & Databases',
    title: 'Database Transactions, ACID Guarantees, and Isolation Levels',
    description: 'Comprehensive guide to ACID properties, dirty reads, non-repeatable reads, phantom reads, and standard SQL isolation levels.',
    readTime: '10 min read',
    lastUpdated: '2026-03-01',
    tags: ['SQL', 'ACID', 'Transactions', 'Concurrency', 'PostgreSQL'],
    summary: 'Transactions allow database operations to be executed with guarantees of safety and consistency. This guide explores the ACID paradigm and the trade-offs of the four ANSI SQL transaction isolation levels.',
    tableOfContents: [
      { id: 'acid-properties', title: '1. The Four ACID Guarantees' },
      { id: 'read-phenomena', title: '2. Concurrency Anomalies & Phenonema' },
      { id: 'isolation-levels', title: '3. SQL Isolation Levels Matrix' },
      { id: 'mvcc', title: '4. Multi-Version Concurrency Control (MVCC)' }
    ],
    sections: [
      {
        id: 'acid-properties',
        heading: '1. The Four ACID Guarantees',
        content: `
          <ul>
            <li><strong>Atomicity:</strong> All-or-nothing execution. If any statement within a transaction fails, all previously executed statements within that transaction are rolled back.</li>
            <li><strong>Consistency:</strong> Transactions transition the database from one valid state to another, satisfying all schema constraints, checks, cascades, and foreign keys.</li>
            <li><strong>Isolation:</strong> Concurrent transactions execute without cross-contamination. Uncommitted changes in one transaction are sequestered according to the isolation level.</li>
            <li><strong>Durability:</strong> Once committed, changes survive system crashes and power failures via write-ahead logging (WAL).</li>
          </ul>
        `
      },
      {
        id: 'read-phenomena',
        heading: '2. Concurrency Anomalies & Phenomena',
        content: `
          <p>The ANSI SQL standard defines three classical phenomena that arise when multiple transactions execute concurrently without adequate isolation:</p>
          <ol>
            <li><strong>Dirty Read:</strong> Transaction A reads data modified by Transaction B that has not yet committed. If Transaction B subsequently rolls back, Transaction A read data that technically never existed.</li>
            <li><strong>Non-Repeatable Read (Fuzzy Read):</strong> Transaction A reads a row. Transaction B modifies or deletes that row and commits. Transaction A re-reads the row and observes changed values.</li>
            <li><strong>Phantom Read:</strong> Transaction A queries a range of rows matching a predicate. Transaction B inserts new rows matching that predicate and commits. Transaction A re-executes the query and sees new "phantom" rows.</li>
          </ol>
        `
      },
      {
        id: 'isolation-levels',
        heading: '3. SQL Isolation Levels Matrix',
        content: `
          <div class="table-responsive">
            <table class="concept-table">
              <thead>
                <tr>
                  <th>Isolation Level</th>
                  <th>Dirty Read</th>
                  <th>Non-Repeatable Read</th>
                  <th>Phantom Read</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>Read Uncommitted</strong></td>
                  <td>Allowed</td>
                  <td>Allowed</td>
                  <td>Allowed</td>
                </tr>
                <tr>
                  <td><strong>Read Committed</strong> (Default in Postgres)</td>
                  <td>Prevented</td>
                  <td>Allowed</td>
                  <td>Allowed</td>
                </tr>
                <tr>
                  <td><strong>Repeatable Read</strong></td>
                  <td>Prevented</td>
                  <td>Prevented</td>
                  <td>Allowed (Prevented in Postgres via MVCC)</td>
                </tr>
                <tr>
                  <td><strong>Serializable</strong></td>
                  <td>Prevented</td>
                  <td>Prevented</td>
                  <td>Prevented</td>
                </tr>
              </tbody>
            </table>
          </div>
        `
      },
      {
        id: 'mvcc',
        heading: '4. Multi-Version Concurrency Control (MVCC)',
        content: `
          <p>Traditional database systems implemented isolation using lock managers (shared read locks, exclusive write locks), which meant <em>readers blocked writers, and writers blocked readers</em>.</p>
          <p>Modern engines like PostgreSQL utilize <strong>Multi-Version Concurrency Control (MVCC)</strong>:</p>
          <ul>
            <li>Every row holds hidden metadata: <code>xmin</code> (creation transaction ID) and <code>xmax</code> (deletion/update transaction ID).</li>
            <li>When a row is updated, PostgreSQL does not overwrite it; instead, it writes a new version (tuple) with <code>xmin = current_tx</code> and marks the old version's <code>xmax = current_tx</code>.</li>
            <li>Each query operates on a snapshot corresponding to its transaction boundary.</li>
            <li><strong>Core benefit:</strong> <em>Readers never block writers, and writers never block readers</em>.</li>
          </ul>
        `
      }
    ]
  },

  // ==========================================
  // PROGRAMMING & ARCHITECTURE CONCEPTS
  // ==========================================
  {
    slug: 'solid-design-principles',
    category: 'programming-concepts',
    categoryName: 'Programming & System Design',
    title: 'SOLID Principles in Software Architecture with Practical Code Examples',
    description: 'Understand Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, and Dependency Inversion for robust enterprise software.',
    readTime: '11 min read',
    lastUpdated: '2026-03-01',
    tags: ['Architecture', 'SOLID', 'Clean Code', 'Object-Oriented Design'],
    summary: 'The SOLID principles are five design guidelines introduced by Robert C. Martin (Uncle Bob) to create software that is easy to maintain, extend, test, and refactor over time.',
    tableOfContents: [
      { id: 'srp', title: '1. Single Responsibility Principle (SRP)' },
      { id: 'ocp', title: '2. Open/Closed Principle (OCP)' },
      { id: 'lsp', title: '3. Liskov Substitution Principle (LSP)' },
      { id: 'isp', title: '4. Interface Segregation Principle (ISP)' },
      { id: 'dip', title: '5. Dependency Inversion Principle (DIP)' }
    ],
    sections: [
      {
        id: 'srp',
        heading: '1. Single Responsibility Principle (SRP)',
        content: `
          <p><em>"A class should have one, and only one, reason to change."</em></p>
          <p>Every module, class, or function should be responsible for a single actor or business domain. When a class handles multiple unrelated responsibilities (e.g., both calculating payroll and generating PDF invoices), changes in one requirement inadvertently break the other.</p>
          <div class="code-block-wrapper">
            <pre><code class="language-java">// ❌ Violation: User manages state, database persistence, and emailing
public class User {
    private String email;
    public void saveToDatabase() { /* SQL logic */ }
    public void sendWelcomeEmail() { /* SMTP logic */ }
}

// ✅ Correct SRP: Separated into distinct collaborators
public class User {
    private String email;
    // pure domain model
}

public class UserRepository {
    public void save(User user) { /* SQL persistence */ }
}

public class NotificationService {
    public void sendWelcomeEmail(User user) { /* SMTP email delivery */ }
}</code></pre>
          </div>
        `
      },
      {
        id: 'ocp',
        heading: '2. Open/Closed Principle (OCP)',
        content: `
          <p><em>"Software entities (classes, modules, functions) should be open for extension, but closed for modification."</em></p>
          <p>You should be able to introduce new behavior without modifying existing, tested source code. This is usually achieved through polymorphism, interfaces, and strategy patterns.</p>
          <div class="code-block-wrapper">
            <pre><code class="language-java">// Extensible Discount Strategy
public interface DiscountStrategy {
    BigDecimal apply(BigDecimal total);
}

public class VipDiscountStrategy implements DiscountStrategy {
    @Override
    public BigDecimal apply(BigDecimal total) {
        return total.multiply(new BigDecimal("0.80"));
    }
}

public class CheckoutService {
    public BigDecimal calculateFinalAmount(BigDecimal cartTotal, DiscountStrategy discount) {
        return discount.apply(cartTotal);
    }
}</code></pre>
          </div>
        `
      },
      {
        id: 'lsp',
        heading: '3. Liskov Substitution Principle (LSP)',
        content: `
          <p><em>"Subtypes must be substitutable for their base types without altering the correctness of the program."</em></p>
          <p>Formulated by Barbara Liskov in 1987. If class <code>S</code> is a subtype of class <code>T</code>, objects of type <code>T</code> may be replaced with objects of type <code>S</code> without breaking the application invariants.</p>
          <p><strong>Classic violation:</strong> The Square-Rectangle problem. If a <code>Square</code> extends <code>Rectangle</code> and overrides <code>setWidth()</code> to also change <code>height</code>, client code assuming independent dimensions will fail when passed a Square.</p>
        `
      },
      {
        id: 'isp',
        heading: '4. Interface Segregation Principle (ISP)',
        content: `
          <p><em>"Clients should not be forced to depend upon interfaces that they do not use."</em></p>
          <p>Prefer small, cohesive, role-specific interfaces over massive "fat" interfaces. In the standard Java library, notice how <code>Iterable</code>, <code>Collection</code>, <code>List</code>, and <code>RandomAccess</code> are segregated so implementing classes only take on the contracts they actually fulfill.</p>
        `
      },
      {
        id: 'dip',
        heading: '5. Dependency Inversion Principle (DIP)',
        content: `
          <p><em>"High-level modules should not depend on low-level modules. Both should depend on abstractions. Abstractions should not depend on details. Details should depend on abstractions."</em></p>
          <p>DIP is the foundational principle underlying <strong>Inversion of Control (IoC)</strong> and <strong>Dependency Injection (DI)</strong> frameworks like Spring and Guice.</p>
          <div class="code-block-wrapper">
            <pre><code class="language-java">// High-level service depends on abstraction (OrderRepository interface)
public class OrderService {
    private final OrderRepository repository;

    // Injected via constructor
    public OrderService(OrderRepository repository) {
        this.repository = repository;
    }

    public void completeOrder(Order order) {
        repository.persist(order);
    }
}</code></pre>
          </div>
        `
      }
    ]
  },
  {
    slug: 'software-design-patterns',
    category: 'programming-concepts',
    categoryName: 'Programming & System Design',
    title: 'Essential Software Design Patterns: Creational, Structural, and Behavioral',
    description: 'A deep architectural reference on the Gang of Four (GoF) design patterns: Factory, Singleton, Builder, Adapter, Decorator, Strategy, and Observer.',
    readTime: '12 min read',
    lastUpdated: '2026-03-01',
    tags: ['Design Patterns', 'GoF', 'Architecture', 'Clean Code'],
    summary: 'Design patterns are repeatable, tested solutions to commonly occurring software engineering problems. This reference details the core Creational, Structural, and Behavioral patterns with practical implementations.',
    tableOfContents: [
      { id: 'creational', title: '1. Creational Patterns: Factory & Builder' },
      { id: 'structural', title: '2. Structural Patterns: Adapter & Decorator' },
      { id: 'behavioral', title: '3. Behavioral Patterns: Strategy & Observer' },
      { id: 'when-to-use', title: '4. Anti-Patterns & Over-Engineering Warnings' }
    ],
    sections: [
      {
        id: 'creational',
        heading: '1. Creational Patterns: Factory & Builder',
        content: `
          <p><strong>Builder Pattern:</strong> Constructs complex objects step-by-step, separating construction from representation. It avoids the "telescoping constructor" anti-pattern:</p>
          <div class="code-block-wrapper">
            <pre><code class="language-java">public class DatabaseConfig {
    private final String host;
    private final int port;
    private final int maxPoolSize;
    private final Duration timeout;

    private DatabaseConfig(Builder b) {
        this.host = b.host;
        this.port = b.port;
        this.maxPoolSize = b.maxPoolSize;
        this.timeout = b.timeout;
    }

    public static class Builder {
        private String host = "localhost";
        private int port = 5432;
        private int maxPoolSize = 10;
        private Duration timeout = Duration.ofSeconds(30);

        public Builder host(String host) { this.host = host; return this; }
        public Builder port(int port) { this.port = port; return this; }
        public Builder maxPoolSize(int size) { this.maxPoolSize = size; return this; }
        public DatabaseConfig build() { return new DatabaseConfig(this); }
    }
}</code></pre>
          </div>
        `
      },
      {
        id: 'structural',
        heading: '2. Structural Patterns: Adapter & Decorator',
        content: `
          <p><strong>Adapter Pattern:</strong> Acts as a bridge between two incompatible interfaces, translating calls from one contract to another.</p>
          <p><strong>Decorator Pattern:</strong> Dynamically attaches additional responsibilities to an object at runtime without sub-classing. The Java I/O streams are the quintessential example: <code>new BufferedReader(new InputStreamReader(new FileInputStream("file.txt")))</code> wraps and decorates the raw byte stream with character conversion and in-memory buffering.</p>
        `
      },
      {
        id: 'behavioral',
        heading: '3. Behavioral Patterns: Strategy & Observer',
        content: `
          <p><strong>Strategy Pattern:</strong> Defines a family of algorithms, encapsulates each one, and makes them interchangeable at runtime. The algorithm varies independently from clients that use it.</p>
          <p><strong>Observer Pattern:</strong> Defines a one-to-many dependency between objects so that when one object (the Subject) changes state, all its dependents (Observers) are notified automatically. This is the cornerstone of event-driven architectures and reactive streaming (e.g. RxJava, EventListeners).</p>
        `
      },
      {
        id: 'when-to-use',
        heading: '4. Anti-Patterns & Over-Engineering Warnings',
        content: `
          <p>Patterns are tools, not goals. Premature application of patterns where simple code suffices leads to unnecessary indirection and accidental complexity. Follow the <strong>Rule of Three</strong>: do not extract an abstraction or pattern until you have implemented the concrete behavior at least three times in distinct contexts.</p>
        `
      }
    ]
  },

  // ==========================================
  // GUIDEWIRE THEORY & GOSU CONCEPTS
  // ==========================================
  {
    slug: 'guidewire-platform-architecture',
    category: 'guidewire-theory',
    categoryName: 'Guidewire Architecture & Gosu',
    title: 'Guidewire InsuranceSuite Architecture: Multi-Tier Framework Overview',
    description: 'Comprehensive architectural guide to Guidewire InsuranceSuite: PolicyCenter, ClaimCenter, BillingCenter, the Data Model, and integration layers.',
    readTime: '10 min read',
    lastUpdated: '2026-03-01',
    tags: ['Guidewire', 'Architecture', 'PolicyCenter', 'ClaimCenter', 'BillingCenter'],
    summary: 'Guidewire InsuranceSuite is an enterprise platform powering property and casualty (P&C) insurance carriers globally. This guide explores the core 3-tier architecture, application clustering, and component interaction.',
    tableOfContents: [
      { id: 'suite-overview', title: '1. The InsuranceSuite Applications' },
      { id: 'runtime-tiers', title: '2. Multi-Tier Runtime Architecture' },
      { id: 'metadata-engine', title: '3. The Metadata-Driven Architecture' },
      { id: 'clustering-scaling', title: '4. High Availability & Clustering' }
    ],
    sections: [
      {
        id: 'suite-overview',
        heading: '1. The InsuranceSuite Applications',
        content: `
          <p>Guidewire InsuranceSuite consists of three core transactional applications built on a shared technological platform:</p>
          <ul>
            <li><strong>PolicyCenter (PC):</strong> Manages underwriting, policy inception, quoting, renewals, endorsements (policy changes), cancellations, and product model definitions.</li>
            <li><strong>ClaimCenter (CC):</strong> Manages the complete claim lifecycle: First Notice of Loss (FNOL), exposure evaluation, reserving, financial transactions (checks, recoveries), subrogation, and salvage.</li>
            <li><strong>BillingCenter (BC):</strong> Handles payment plans, invoicing, direct billing, agency billing, commissions, delinquency workflows, and payment allocation.</li>
          </ul>
        `
      },
      {
        id: 'runtime-tiers',
        heading: '2. Multi-Tier Runtime Architecture',
        content: `
          <p>Guidewire runs on the Java Virtual Machine (JVM) using an enterprise multi-tier architecture:</p>
          <ol>
            <li><strong>Client Tier (Browser):</strong> Renders the web UI dynamically generated by the Page Configuration Format (PCF) engine into HTML5 and JavaScript.</li>
            <li><strong>Application Tier (JVM / Application Server):</strong> Executes business logic, the Gosu compiler, rules engines, workflow managers, and security access controls.</li>
            <li><strong>Integration Tier:</strong> Exposes and consumes REST/SOAP APIs, messaging plugins, startable background processes, and queue listeners.</li>
            <li><strong>Data Tier (RDBMS):</strong> Relational databases (PostgreSQL, Oracle, SQL Server) storing configuration and transaction entities with object-relational mapping handled by the Guidewire Data Model engine.</li>
          </ol>
        `
      },
      {
        id: 'metadata-engine',
        heading: '3. The Metadata-Driven Architecture',
        content: `
          <p>A core architectural strength of Guidewire is its <strong>metadata-driven configuration</strong>:</p>
          <ul>
            <li>Entities are declared in XML definition files (<code>.eti</code>) and extension files (<code>.etx</code>).</li>
            <li>User interfaces are declared in XML Page Configuration Format files (<code>.pcf</code>).</li>
            <li>Typelists (enumerations) are defined in <code>.tti</code> and extended in <code>.ttx</code> files.</li>
            <li>At startup, the Guidewire runtime compiles these metadata definitions into native Java bytecode classes, ensuring compile-time type safety across the entire application stack.</li>
          </ul>
        `
      },
      {
        id: 'clustering-scaling',
        heading: '4. High Availability & Clustering',
        content: `
          <p>Guidewire servers are deployed in clustered configurations using Hazelcast or JGroups for distributed state coordination:</p>
          <ul>
            <li><strong>User Nodes:</strong> Handle interactive UI traffic behind a load balancer with sticky sessions.</li>
            <li><strong>Batch / Batch Server Node:</strong> A designated single node or cluster that executes scheduled batch processes (e.g. invoice generation, renewal processing, work queues) without degrading user session performance.</li>
          </ul>
        `
      }
    ]
  },
  {
    slug: 'gosu-language-fundamentals',
    category: 'guidewire-theory',
    categoryName: 'Guidewire Architecture & Gosu',
    title: 'Gosu Language Fundamentals: Typing, Enhancements, and Blocks',
    description: 'Learn Gosu syntax, static typing with type inference, Enhancement files, Properties, and Closure Blocks with comparisons to Java.',
    readTime: '9 min read',
    lastUpdated: '2026-03-01',
    tags: ['Gosu', 'Guidewire', 'Programming', 'Language Design'],
    summary: 'Gosu is a pragmatic, statically typed object-oriented programming language designed for the Java Virtual Machine (JVM). It combines 100% Java interoperability with modern language idioms.',
    tableOfContents: [
      { id: 'typing-inference', title: '1. Static Typing & Type Inference' },
      { id: 'enhancements', title: '2. Gosu Enhancements (Open Classes)' },
      { id: 'properties', title: '3. First-Class Properties' },
      { id: 'blocks', title: '4. Blocks (Closures / Lambdas)' }
    ],
    sections: [
      {
        id: 'typing-inference',
        heading: '1. Static Typing & Type Inference',
        content: `
          <p>Gosu is 100% statically typed and runs directly on the JVM, compiling to native Java bytecode. However, unlike traditional Java, Gosu utilizes local type inference via the <code>var</code> keyword:</p>
          <div class="code-block-wrapper">
            <pre><code class="language-gosu">// Explicit vs Inferred typing
var explicitList : List&lt;String&gt; = new ArrayList&lt;String&gt;()
var inferredList = new ArrayList&lt;String&gt;() // Type is strictly List&lt;String&gt;

// Null-safe navigation operator (?.)
var zipCode = policy.PrimaryNamedInsured.AccountContact.Contact.PrimaryAddress?.PostalCode</code></pre>
          </div>
        `
      },
      {
        id: 'enhancements',
        heading: '2. Gosu Enhancements (Open Classes)',
        content: `
          <p><strong>Enhancements</strong> are one of Gosu's most celebrated features. An enhancement allows developers to add new methods and computed properties to existing classes—including compiled Java classes, third-party libraries, and out-of-the-box Guidewire entity types—<strong>without subclassing</strong> and without breaking encapsulation:</p>
          <div class="code-block-wrapper">
            <pre><code class="language-gosu">package gw.entity

// Enhances the standard Claim entity
enhancement ClaimCustomEnhancement : Claim {
  property get TotalIncurredLoss() : MonetaryAmount {
    return this.ClaimRpt.OpenReserves.add(this.ClaimRpt.TotalPayments)
  }

  function sendUnderwritingReviewAlert(reason : String) {
    if (this.State == ClaimState.TC_OPEN) {
      Activity.createActivity(this, "Review Required: " + reason)
    }
  }
}</code></pre>
          </div>
          <p>Once declared, <code>claim.TotalIncurredLoss</code> is directly available with full IDE code completion and compile-time verification across the entire project.</p>
        `
      },
      {
        id: 'properties',
        heading: '3. First-Class Properties',
        content: `
          <p>In Gosu, getters and setters are elevated to first-class syntactic properties:</p>
          <div class="code-block-wrapper">
            <pre><code class="language-gosu">class PremiumCalculator {
  private var _baseRate : BigDecimal

  property get BaseRate() : BigDecimal {
    return _baseRate
  }

  property set BaseRate(val : BigDecimal) {
    if (val &lt; 0) throw new IllegalArgumentException("Rate cannot be negative")
    _baseRate = val
  }
}</code></pre>
          </div>
        `
      },
      {
        id: 'blocks',
        heading: '4. Blocks (Closures / Lambdas)',
        content: `
          <p>Gosu introduced <strong>Blocks</strong> (closures) years before Java 8 introduced lambdas. Blocks are declared using <code>\\ param1, param2 -&gt; expression</code>:</p>
          <div class="code-block-wrapper">
            <pre><code class="language-gosu">var openClaims = claimList.where(\\ c -&gt; c.State == ClaimState.TC_OPEN)
var highValueClaims = openClaims.where(\\ c -&gt; c.ClaimRpt.TotalIncurredLoss &gt; 100000)
var policyNumbers = highValueClaims.map(\\ c -&gt; c.Policy.PolicyNumber)</code></pre>
          </div>
        `
      }
    ]
  },
  {
    slug: 'guidewire-database-bundles',
    category: 'guidewire-theory',
    categoryName: 'Guidewire Architecture & Gosu',
    title: 'Guidewire Bundles & Database Transaction Lifecycle',
    description: 'Master Guidewire database bundles: Current Bundle, New Bundle, Bundle Commit lifecycle, bean cloning, and avoiding read-only entity modification errors.',
    readTime: '10 min read',
    lastUpdated: '2026-03-01',
    tags: ['Guidewire', 'Gosu', 'Bundles', 'Transactions', 'Database'],
    summary: 'In Guidewire, all database mutations (inserts, updates, deletes) are mediated through Bundles. A bundle acts as a Unit of Work and transactional boundary.',
    tableOfContents: [
      { id: 'bundle-concept', title: '1. What is a Bundle?' },
      { id: 'bundle-types', title: '2. Current vs New Bundle' },
      { id: 'readonly-vs-writable', title: '3. Read-Only Beans vs Writable Clones' },
      { id: 'commit-lifecycle', title: '4. The Bundle Commit Sequence' }
    ],
    sections: [
      {
        id: 'bundle-concept',
        heading: '1. What is a Bundle?',
        content: `
          <p>A <strong>Bundle</strong> in Guidewire is an in-memory Unit of Work (similar to Hibernate's Session or JPA's EntityManager). It tracks all entities modified, created, or marked for deletion during a business transaction.</p>
          <p><strong>Core Rule:</strong> <em>You cannot modify a database entity unless it is held in a writable bundle.</em> Attempting to set a field on a read-only entity retrieved outside a transaction raises a <code>ReadOnlyEntityException</code>.</p>
        `
      },
      {
        id: 'bundle-types',
        heading: '2. Current vs New Bundle',
        content: `
          <p>Depending on context, you either join the existing UI transaction or initiate a standalone programmatic transaction:</p>
          <div class="code-block-wrapper">
            <pre><code class="language-gosu">// 1. Web UI Context: The framework provides the Current bundle
// Triggered on PCF "Update" button press:
var claim = pcfClaim // Already in the current UI bundle
claim.Description = "Updated description"

// 2. Standalone / Batch / Integration Context: Transaction.runWithNewBundle
gw.transaction.Transaction.runWithNewBundle(\\ bundle -&gt; {
  var localClaim = bundle.add(claim) // Add read-only bean to writable bundle
  localClaim.Description = "Updated in standalone transaction"
  
  var newActivity = new Activity(bundle) // Instantiating inside bundle
  newActivity.Subject = "Review Claim Status"
  newActivity.Claim = localClaim
}) // Automatically commits at the end of the block</code></pre>
          </div>
        `
      },
      {
        id: 'readonly-vs-writable',
        heading: '3. Read-Only Beans vs Writable Clones',
        content: `
          <p>When you query the database using <code>Query.make()</code>, the returned entities are <strong>read-only</strong>. To modify an entity, you must pass it to <code>bundle.add(entity)</code>:</p>
          <div class="code-block-wrapper">
            <pre><code class="language-gosu">var queryResult = Query.make(Policy).compare("PolicyNumber", Equals, "POL-123").select().FirstResult

// queryResult is READ-ONLY!
gw.transaction.Transaction.runWithNewBundle(\\ bundle -&gt; {
  var writablePolicy = bundle.add(queryResult) // Returns writable clone
  writablePolicy.Priority = Priority.TC_HIGH
})</code></pre>
          </div>
        `
      },
      {
        id: 'commit-lifecycle',
        heading: '4. The Bundle Commit Sequence',
        content: `
          <p>When a bundle commits, the platform executes a rigorous transactional pipeline:</p>
          <ol>
            <li><strong>Pre-Update Rules:</strong> Runs entity-specific pre-update rule sets.</li>
            <li><strong>Validation Rules:</strong> Executes validation logic to ensure data consistency.</li>
            <li><strong>Database INSERT / UPDATE / DELETE statements:</strong> Flushed to the database within a JDBC transaction.</li>
            <li><strong>Database Commit:</strong> Transaction committed at the RDBMS level.</li>
            <li><strong>Post-Commit Events:</strong> Messaging engine generates event messages for external integrations.</li>
          </ol>
        `
      }
    ]
  }
];

// Helper functions
export function getAllCategories() {
  return CATEGORIES;
}

export function getCategory(slug) {
  if (!slug) return null;
  if (slug === 'guidewire') {
    return CATEGORIES.find(c => c.slug === 'guidewire-theory') || null;
  }
  return CATEGORIES.find(c => c.slug === slug) || null;
}

export function getAllArticles() {
  return [...ARTICLES, ...getConceptArticles()];
}

export function getArticlesByCategory(categorySlug) {
  const normCat = categorySlug === 'guidewire' ? 'guidewire-theory' : categorySlug;
  const curated = ARTICLES.filter(a => a.category === normCat);
  const concepts = getConceptArticlesByCategory(normCat);
  return [...curated, ...concepts];
}

export function getArticle(categorySlug, articleSlug) {
  const normCat = categorySlug === 'guidewire' ? 'guidewire-theory' : categorySlug;
  const curated = ARTICLES.find(a =>
    (a.category === normCat || (normCat === 'guidewire-theory' && a.category === 'guidewire')) &&
    a.slug === articleSlug
  );
  if (curated) return curated;
  return getConceptArticle(normCat, articleSlug);
}

export function searchArticles(query) {
  if (!query || typeof query !== 'string') return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all = getAllArticles();
  return all.filter(a => {
    return (
      (a.title && a.title.toLowerCase().includes(q)) ||
      (a.description && a.description.toLowerCase().includes(q)) ||
      (a.summary && a.summary.toLowerCase().includes(q)) ||
      (a.tags && a.tags.some(t => t.toLowerCase().includes(q))) ||
      (a.questions && a.questions.some(qn => qn.toLowerCase().includes(q)))
    );
  });
}

export function getRelatedArticles(categorySlug, currentSlug, limit = 3) {
  const normCat = categorySlug === 'guidewire' ? 'guidewire-theory' : categorySlug;
  const inCat = getArticlesByCategory(normCat);
  return inCat
    .filter(a => a.slug !== currentSlug)
    .slice(0, limit);
}

export function isPublicKnowledgeEnabled() {
  if (typeof process.env.PUBLIC_KNOWLEDGE_ENABLED === 'string') {
    const val = process.env.PUBLIC_KNOWLEDGE_ENABLED.trim().toLowerCase();
    if (val === 'false' || val === '0' || val === 'no' || val === 'off') {
      return false;
    }
    if (val === 'true' || val === '1' || val === 'yes' || val === 'on') {
      return true;
    }
    return true;
  }
  return true;
}

