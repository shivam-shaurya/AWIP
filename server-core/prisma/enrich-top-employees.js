import { faker } from '@faker-js/faker';
import { prisma } from '../db.js';

// Adds richer, narrative-heavy records for the 100 most senior employees
// (cadre "Class I" — Deputy Commissioners, Chief Engineers, Chief Medical
// Officer, etc.) across the modules Employee 360 actually renders
// (Awards & Events, Performance, Documents/Career, Training, Skills) —
// requested as a "super detailed" profile pass on top of the standard seed.
//
// Unlike seed.js's main(), this script is strictly ADDITIVE: it never calls
// deleteMany()/truncate on any table. It only ever adds new rows for the 100
// targeted employees, on top of whatever the standard seed already produced.
// This is deliberate — the last attempt at this same task wiped every
// employee-linked table for all 10,000 employees, and this script exists so
// that can't happen again.
//
// Idempotent: every targeted employee gets an EmployeeEvent with an
// `ENR100-` id prefix as part of this pass. Re-running the script checks for
// that marker first and skips any employee who already has it, so running it
// twice never duplicates data.

const TARGET_COUNT = 100;
const NOW_YEAR = new Date().getFullYear();

async function main() {
  // "Important posts" — cadre "Class I" is the senior-officer tier (Deputy
  // Commissioners, Chief Engineers, Chief Medical Officer, Superintending
  // Engineers, etc.), deliberately excluding the Class II-IV clerical/
  // support-staff designations (Peon, Helper, Driver, Junior Clerk, ...)
  // that raw id-ascending order would otherwise sweep in.
  const employees = await prisma.employee.findMany({
    where: { cadre: 'Class I' },
    orderBy: { id: 'asc' },
    take: TARGET_COUNT,
  });
  console.log(`Enriching ${employees.length} senior-post employees (Class I cadre)`);

  let skipped = 0;
  let enriched = 0;

  for (const e of employees) {
    const already = await prisma.employeeEvent.findFirst({
      where: { employeeId: e.id, id: { startsWith: 'ENR100-' } },
      select: { id: true },
    });
    if (already) {
      skipped++;
      continue;
    }

    const tenure = Math.max(1, NOW_YEAR - Number(String(e.doj).slice(0, 4)));

    // 1. Awards & Events — two detailed narrative "posts" per employee.
    await prisma.employeeEvent.createMany({
      data: [
        {
          id: `ENR100-EVT-${e.id}-1`,
          employeeId: e.id,
          kind: 'Award',
          title: 'Career Spotlight',
          category: 'Excellence',
          date: faker.date.past({ years: 2 }).toISOString().slice(0, 10),
          description: `Recognized as a standout ${e.designation} within ${e.department} after ${tenure} year${tenure === 1 ? '' : 's'} of service — cited for consistent delivery, sound judgment under pressure, and a track record the department's senior leadership holds up as a benchmark for the role.`,
          awardedBy: 'AWIP People Analytics — Deep Profile',
          isPublic: true,
        },
        {
          id: `ENR100-EVT-${e.id}-2`,
          employeeId: e.id,
          kind: 'LifeEvent',
          title: 'Extended Service Narrative',
          category: 'Milestone',
          date: faker.date.past({ years: 1 }).toISOString().slice(0, 10),
          description: `A closer look at ${e.name}'s time as ${e.designation} shows a steady arc: early responsibilities in ${e.department} gave way to broader ownership, with peers and reporting officers alike noting reliable follow-through on cross-team commitments.`,
          awardedBy: null,
          isPublic: false,
        },
      ],
      skipDuplicates: true,
    });

    // 2. Performance — one additional, deeper historical year (seed.js only
    // covers NOW_YEAR-2..NOW_YEAR) with a long-form review instead of the
    // template one-liner.
    const deepYear = NOW_YEAR - 3;
    const alreadyHasDeepYear = await prisma.performanceRecord.findFirst({
      where: { employeeId: e.id, year: deepYear },
      select: { id: true },
    });
    if (!alreadyHasDeepYear) {
      const rating = Math.round(faker.number.float({ min: 2.8, max: 4.6, fractionDigits: 1 }) * 10) / 10;
      await prisma.performanceRecord.create({
        data: {
          employeeId: e.id,
          year: deepYear,
          rating,
          attritionRiskScore: Math.round(faker.number.float({ min: 5, max: 40 }) * 10) / 10,
          reviewComments: `Extended review for ${deepYear}: as ${e.designation} in ${e.department}, ${e.name} handled a full cycle of core responsibilities with minimal escalation, closed the year with a rating of ${rating}/5, and was noted for mentoring newer staff informally alongside their own caseload.`,
          reviewedBy: `Senior Reporting Officer, ${e.department} (Extended Profile)`,
        },
      });
    }

    // 3. Documents/Career — one additional detailed service-book entry.
    const sbeId = `ENR100-SBE-${e.id}`;
    await prisma.serviceBookEntry.createMany({
      data: [{
        id: sbeId,
        employeeId: e.id,
        type: 'Character & Antecedent Verification',
        date: faker.date.past({ years: 3 }).toISOString().slice(0, 10),
        ocrScore: Math.round(faker.number.float({ min: 92, max: 99.5 }) * 10) / 10,
        status: 'Verified',
        description: `Detailed character and antecedent verification on file for ${e.name}, ${e.designation}, ${e.department} — cleared without adverse remarks, supporting an extended service narrative beyond the standard appointment record.`,
      }],
      skipDuplicates: true,
    });

    // 4. Training — one additional advanced/leadership training beyond the
    // standard 1-3 rows every employee already gets.
    const advancedTitle = 'Advanced Leadership & Governance Program';
    const alreadyHasAdvanced = await prisma.trainingRecord.findFirst({
      where: { employeeId: e.id, title: advancedTitle },
      select: { id: true },
    });
    if (!alreadyHasAdvanced) {
      await prisma.trainingRecord.create({
        data: {
          employeeId: e.id,
          title: advancedTitle,
          category: 'Leadership',
          completionDate: faker.date.past({ years: 2 }).toISOString().slice(0, 10),
          status: 'Completed',
        },
      });
    }

    // 5. Skills — two additional specialized/leadership skills beyond the
    // standard pool.
    const extraSkills = ['Stakeholder Negotiation', 'Cross-Department Coordination'];
    for (const skillName of extraSkills) {
      const alreadyHasSkill = await prisma.employeeSkill.findFirst({
        where: { employeeId: e.id, name: skillName },
        select: { id: true },
      });
      if (!alreadyHasSkill) {
        await prisma.employeeSkill.create({
          data: {
            employeeId: e.id,
            name: skillName,
            proficiency: faker.helpers.arrayElement(['Intermediate', 'Expert']),
            acquiredDate: faker.date.past({ years: 2 }).toISOString().slice(0, 10),
          },
        });
      }
    }

    enriched++;
  }

  console.log(`Done. Enriched ${enriched} employees, skipped ${skipped} already-enriched.`);
}

main()
  .catch((e) => {
    console.error('Enrichment failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
