import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

export class CreateTimeOffRequestDto {
  @ApiProperty({
    description: 'Employee submitting the request',
    example: 'emp-123',
  })
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @ApiProperty({
    description: 'HCM location dimension',
    example: 'loc-us-west',
  })
  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @ApiProperty({
    description: 'HCM leave type (e.g. vacation, sick)',
    example: 'VACATION',
  })
  @IsString()
  @IsNotEmpty()
  leaveTypeId!: string;

  @ApiProperty({
    description: 'Start date (YYYY-MM-DD)',
    example: '2025-08-01',
  })
  @IsDateString()
  startDate!: string;

  @ApiProperty({
    description: 'End date inclusive (YYYY-MM-DD)',
    example: '2025-08-05',
  })
  @IsDateString()
  endDate!: string;

  @ApiProperty({ description: 'Number of leave days requested', example: 5 })
  @IsNumber()
  @IsPositive()
  numberOfDays!: number;

  @ApiProperty({
    description: 'Optional manager to route for approval',
    nullable: true,
    required: false,
  })
  @IsString()
  @IsOptional()
  managerId?: string;

  @ApiProperty({
    description: 'Optional reason / note',
    nullable: true,
    required: false,
  })
  @IsString()
  @IsOptional()
  reason?: string;
}
